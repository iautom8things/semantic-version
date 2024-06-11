const core = require('@actions/core');
const exec = require("@actions/exec");
const eol = '\n';

const tagPrefix = core.getInput('tag_prefix') || '';
const namespace = core.getInput('namespace') || '';
const shortTags = core.getInput('short_tags') === 'true';
const bumpEachCommit = core.getInput('bump_each_commit') === 'true';
const useTestValue = core.getInput('use_test_value') === 'true';
const testValue = core.getInput('test_value', { required: true });

const cmd = async (command, ...args) => {
  let output = '', errors = '';
  const options = {
    silent: true
  };
  options.listeners = {
    stdout: (data) => { output += data.toString(); },
    stderr: (data) => { errors += data.toString(); },
    ignoreReturnCode: true,
    silent: true
  };

  await exec.exec(command, args, options)
    .catch(err => { core.info(`The command '${command} ${args.join(' ')}' failed: ${err}`); });

  if (errors !== '') {
    core.info(`stderr: ${errors}`);
  }

  return output;
};

const setOutput = (major, minor, patch, increment, changed, branch, namespace) => {
  const format = core.getInput('format', { required: true });
  var version = format
    .replace('${major}', major)
    .replace('${minor}', minor)
    .replace('${patch}', patch)
    .replace('${increment}', increment);

  if (namespace !== '') {
    version += `-${namespace}`
  }

  let tag;
  if (!shortTags || major === 0 || patch !== 0) {
    // Always tag pre-release/major version 0 as full version
    tag = `${tagPrefix}${major}.${minor}.${patch}`;
  } else if (minor !== 0) {
    tag = `${tagPrefix}${major}.${minor}`;
  } else {
    tag = `${tagPrefix}${major}`;
  }

  if (namespace !== '') {
    tag += `-${namespace}`
  }

  const repository = process.env.GITHUB_REPOSITORY;

  if (!changed) {
    core.info('No changes detected for this commit');
  }

  core.info(`Version is ${major}.${minor}.${patch}+${increment}`);
  core.info(`Formatted Version: ${tag}`)
  if (repository !== undefined && !namespace) {
    core.info(`To create a release for this version, go to https://github.com/${repository}/releases/new?tag=${tag}&target=${branch.split('/').reverse()[0]}`);
  }

  core.setOutput("test_value", testValue);
  core.setOutput("use_test_value", useTestValue);
  core.setOutput("version", version);
  core.setOutput("major", major.toString());
  core.setOutput("minor", minor.toString());
  core.setOutput("patch", patch.toString());
  core.setOutput("increment", increment.toString());
  core.setOutput("changed", changed.toString());
  core.setOutput("version_tag", tag);

};

const parseVersion = (tag) => {

  let stripedTag;
  if (tagPrefix.includes('/') && tag.includes(tagPrefix)) {
    let tagParts = tag
      .replace(tagPrefix, '<--!PREFIX!-->')
      .split('/');
    stripedTag = tagParts[tagParts.length - 1]
      .replace('<--!PREFIX!-->', tagPrefix);
  } else {
    let tagParts = tag.split('/');
    stripedTag = tagParts[tagParts.length - 1];
  }
  let versionValues = stripedTag
    .substr(tagPrefix.length)
    .slice(0, namespace === '' ? 999 : -(namespace.length + 1))
    .split('.');

  let major = parseInt(versionValues[0]);
  let minor = versionValues.length > 1 ? parseInt(versionValues[1]) : 0;
  let patch = versionValues.length > 2 ? parseInt(versionValues[2]) : 0;

  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    throw `Invalid tag ${tag} (${versionValues})`;
  }

  return [major, minor, patch];
};

const createMatchTest = (pattern) => {

  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    var regex = new RegExp(pattern.slice(1, -1));
    return (l) => regex.test(l);
  } else {
    return (l) => l.includes(pattern);
  }

};

async function run() {
  try {
    let versionBranch = core.getInput('branch', { required: true });
    const majorPattern = createMatchTest(core.getInput('major_pattern', { required: true }));
    const minorPattern = createMatchTest(core.getInput('minor_pattern', { required: true }));
    const changePath = core.getInput('change_path') || '';

    const onHead = versionBranch === 'HEAD';

    if (onHead) {
      versionBranch = (await cmd('git', 'rev-parse', 'HEAD')).trim();
    }

    const versionPattern = shortTags ? '*[0-9.]' : '*[0-9].*[0-9].*[0-9]'
    const releasePattern = namespace === '' ? `${tagPrefix}${versionPattern}` : `${tagPrefix}${versionPattern}-${namespace}`;
    let major = 0, minor = 0, patch = 0, increment = 0;
    let changed = true;

    let lastCommitAll = (await cmd('git', 'rev-list', '-n1', '--all')).trim();

    if (lastCommitAll === '') {
      // empty repo
      setOutput('0', '0', '0', '0', changed, versionBranch, namespace);
      return;
    }

    let currentTag = (await cmd(
      `git tag --points-at ${versionBranch} ${releasePattern}`
    )).trim();

    let tag = '';
    try {
      tag = (await cmd(
        'git',
        `describe`,
        `--tags`,
        `--abbrev=0`,
        `--match=${releasePattern}`,
        `${versionBranch}~1`
      )).trim();
    }
    catch (err) {
      tag = '';
    }

    let root;
    if (tag === '') {
      if (await cmd('git', 'remote') !== '') {
        core.warning('No tags are present for this repository. If this is unexpected, check to ensure that tags have been pulled from the remote.');
      }
      // no release tags yet, use the initial commit as the root
      root = '';
    } else {
      // parse the version tag
      [major, minor, patch] = parseVersion(tag);

      root = await cmd('git', `merge-base`, tag, versionBranch);
    }
    root = root.trim();

    var logCommand = `git log --pretty="%s" --author-date-order ${(root === '' ? versionBranch : `${root}..${versionBranch}`)}`;

    if (changePath !== '') {
      logCommand += ` -- ${changePath}`;
    }

    const log = await cmd(logCommand);

    if (changePath !== '') {
      if (root === '') {
        const command = `git log --name-only --oneline ${versionBranch} -- ${changePath}`;
        core.info(`No tags found, checking all commits with command: ${command}`);
        const changedFiles = await cmd(command);
        changed = changedFiles.length > 0;
        if (changed) {
          core.info('No changes detected for this commit');
        } else {
          core.info('Changes detected for this commit');
          core.info('Changed files:');
          core.info(changedFiles);
        }
      } else {
        const command = `git diff --name-only ${root}..${versionBranch} -- ${changePath}`;
        core.info(`Checking changes: ${command}`);
        const changedFiles = await cmd(command);
        changed = changedFiles.length > 0;
        if (changed) {
          core.info('No changes detected for this commit');
        } else {
          core.info('Changes detected for this commit');
          core.info('Changed files:');
          core.info(changedFiles);
        }
      }
    }

    core.info(`Changed: ${changed} ${changed.toString()} for ${changePath} [${versionBranch}]`);

    let history = log
      .trim()
      .split(eol)
      .reverse();

    if (bumpEachCommit) {
      core.info(history)
      history.forEach(line => {
        if (currentTag) {
          [major, minor, patch] = parseVersion(currentTag);
        } else if (majorPattern(line)) {
          major += 1;
          minor = 0;
          patch = 0;
        } else if (minorPattern(line)) {
          minor += 1;
          patch = 0;
        } else {
          patch += 1;
        }
      });

      setOutput(major, minor, patch, increment, changed, versionBranch, namespace);
      return;
    }

    if (useTestValue) {
      if (majorPattern(testValue)) {
        major++;
        minor = 0;
        patch = 0;
      } else if (minorPattern(testValue)) {
        minor++;
        patch = 0;
      } else {
        patch++;
      }
      increment = history.length - 1;
      setOutput(major, minor, patch, increment, changed, versionBranch, namespace);
      return;
    }

    // Discover the change time from the history log by finding the oldest log
    // that could set the version.

    const majorIndex = history.findIndex(x => majorPattern(x));
    const minorIndex = history.findIndex(x => minorPattern(x));

    if (majorIndex !== -1) {
      increment = history.length - (majorIndex + 1);
      patch = 0;
      minor = 0;
      major++;
    } else if (minorIndex !== -1) {
      increment = history.length - (minorIndex + 1);
      patch = 0;
      minor++;
    } else {
      increment = history.length - 1;
      patch++;
    }

    if (currentTag) {
      let tagVersion = parseVersion(currentTag);
      if (tagVersion[0] !== major ||
        tagVersion[1] !== minor ||
        tagVersion[2] !== patch) {
        [major, minor, patch] = tagVersion;
        increment = 0;
      }
    }

    setOutput(major, minor, patch, increment, changed, versionBranch, namespace);

  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
}

run();

