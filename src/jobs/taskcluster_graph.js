import instantiate from '../try/instantiate'
import request from 'superagent-promise';
import slugid from 'slugid';
import taskcluster from 'taskcluster-client';
import fs from 'mz/fs';
import fsPath from 'path';
import mustache from 'mustache';
import * as projectConfig from '../project_scopes';
import assert from 'assert';
import retry from 'promise-retries';
import yaml from 'js-yaml';

import Path from 'path';
import Base from './base';
import URL from 'url';

const GRAPH_RETIRES = 2;
const GRAPH_INTERVAL = 5000;
const GRAPH_REQ_TIMEOUT = 30000;
const TRY_PREFIX = 'try:';

/**
Parses given url into path and host parts.


  parseUrl('https://hg.mozilla.org/try/');
  // => { host: 'https://hg.mozilla.org', path: '/try' }

*/
function parseUrl(url) {
  let parsed = URL.parse(url);
  let path = Path.resolve(parsed.path);

  path = (path === '/') ? '' : path;

  return {
    path,
    host: `${parsed.protocol || 'http'}//${parsed.host}`
  };
}

/**
Parse out a try flag in the commit message.
*/
function parseCommitMessage(message) {
  let tryIdx = message.indexOf(TRY_PREFIX);

  // No try...
  if (tryIdx === -1) return null;

  // End of try details are first newline or end of string...
  let endIdx = message.indexOf('\n', tryIdx);
  endIdx = (endIdx === -1) ? message.length : endIdx;

  let msg = message.slice(tryIdx, endIdx);
  return msg;
}

export default class TaskclusterGraphJob extends Base {
  async work(job) {
    let { revision_hash, pushref, repo } = job.data;
    let push = await this.runtime.pushlog.getOne(repo.url, pushref.id);
    let lastChangeset = push.changesets[push.changesets.length - 1];
    let pushdate = push.date;

    let level = projectConfig.level(this.config.try, repo.alias);
    let scopes = projectConfig.scopes(this.config.try, repo.alias);

    // All pushes should at least be able to send
    // emails to the submitting user if desired.
    scopes.push('queue:route:notify.email.' + push.user + '.*');

    let templateVariables = {
      owner: push.user,
      revision: lastChangeset.node,
      project: repo.alias,
      level: level,
      revision_hash,
      // Intention use of ' ' must be a non zero length string...
      comment: parseCommitMessage(lastChangeset.desc) || ' ',
      pushlog_id: String(push.id),
      url: repo.url,
      pushdate
    };

    let repositoryUrlParts = parseUrl(repo.url);
    let urlVariables = {
      // These values are defined in projects.yml
      alias: repo.alias,
      revision: lastChangeset.node,
      path: repositoryUrlParts.path,
      host: repositoryUrlParts.host
    };

    let graphUrl = projectConfig.tcYamlUrl(this.config.try, urlVariables);
    console.log(`Fetching '.taskcluster.yml' url ${graphUrl} for '${repo.alias}' push id ${push.id}`);
    let graphText = await this.fetchGraph(graphUrl);
    templateVariables.source = graphUrl;
    // Assume .taskcluster.yml has been fetched successfully
    let queue = new taskcluster.Queue({
      credentials: this.config.taskcluster.credentials,
      authorizedScopes: scopes
    });

    return await this.scheduleTaskGroup(queue,
                                        repo.alias,
                                        graphText,
                                        templateVariables,
                                        scopes,
                                        this.config.try.errorTask);
  }

  async scheduleTaskGroup(client, project, template, templateVariables, scopes, errorGraphTemplate) {
    let renderedTemplate;
    let groupId;

    try {
      renderedTemplate = this.renderTemplate(project, template, templateVariables);
    } catch(e) {
      console.log(`Error interpreting .taskcluster.yml: ${e.message}`);
      // Even though we won't end up doing anything overly useful we still need
      // to convey some status to the end user ... The instantiate error should
      // be safe to pass as it is simply some yaml error.
      // TODO: use json-e instead of instantiate
      renderedTemplate = instantiate(errorGraphTemplate, templateVariables);
      renderedTemplate.tasks[0].task.payload.env = renderedTemplate.tasks[0].task.payload.env || {};
      renderedTemplate.tasks[0].task.payload.env.ERROR_MSG = e.toString()
    }

    // Iterate over the tasks and ignore other graph related fields that might
    // exist
    for (let task of renderedTemplate.tasks) {
      let taskId = slugid.nice();

      // set the groupId to match the taskId of the first task in the graph
      if (!groupId) {
        groupId = taskId;
      }

      let taskDefinition = task;
      // Support version 0 .taskcluster.yml files that listed tasks as
      // [{taskId: ..., task: <definition>}, ...]
      if (task.task) {
        taskDefinition = task.task;
      }

      // Give all tasks within the task template the scopes allowed for the
      // given project.  This makes the assumption that the template only contains
      // one task, which is a decision task.
      let taskDefinitionScopes = taskDefinition.scopes || [];
      let taskScopes = new Set(taskDefinitionScopes.concat(scopes));
      taskDefinition.scopes = Array.from(taskScopes);

      // taskGroupId can't be specified in the template
      taskDefinition.taskGroupId = groupId;

      console.log(
        `Creating task. Project: ${project} ` +
        `Revision: ${templateVariables.revision} Task ID: ${taskId}`
      );
      try {
        await client.createTask(taskId, taskDefinition);
        console.log(
          `Created task. Project: ${project} ` +
          `Revision: ${templateVariables.revision} Task ID: ${taskId}`
        );
      } catch(e) {
        console.log(`Error creating task ${taskId} for project ${project}, ${e.message}`);
        throw e;
      }
    }
  }

  renderTemplate(project, template, templateVariables) {
    // determine the version number
    let version;
    try {
      let data = yaml.safeLoad(template);
      version = data.version;
    } catch(e) {
      // version 0 templates are not valid YAML until run through mustache, so
      // if the YAML load fails, but `version: 0` is in the text, we will
      // consider it version 0
      if (template.indexOf('version: 0') !== -1) {
        version = 0;
      } else {
        throw e;
      }
    }

    if (version === 0) {
      return this.renderTemplateV0(project, template, templateVariables);
    } else {
      throw new Error('Unrecognized .taskcluster.yml version');
    }
  }

  renderTemplateV0(project, template, templateVariables) {
    let schedulerId = `gecko-level-${templateVariables.level}`;

    let renderedTemplate = instantiate(template, templateVariables);
    for (let task of renderedTemplate.tasks) {
      task.task.schedulerId = schedulerId;
    }

    return renderedTemplate;
  }

  /**
  Fetch a task graph from a url (retries included...)
  */
  async fetchGraph(url) {
    assert(url, 'url is required');
    let opts = { interval: GRAPH_INTERVAL, retires: GRAPH_RETIRES };
    try {
      return await retry(opts, async () => {
        let res = await request.get(url).
          timeout(GRAPH_REQ_TIMEOUT).
          buffer(true).
          end();

        if (res.error) throw res.error;
        return res.text;
      });
    } catch (e) {
      throw new Error(`Could not fetch graph at ${url}\n ${e.stack}`);
    }
  }
}
