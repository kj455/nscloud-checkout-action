import * as core from '@actions/core'
import * as github from '@actions/github'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'

export async function run(): Promise<void> {
  try {
    const ownerRepo = core.getInput('repository') // owner/repository
    core.debug(`Repository ${ownerRepo}`)
    const splitRepo = ownerRepo.split('/')
    const owner = splitRepo[0]
    const repo = splitRepo[1]

    let ref = core.getInput('ref')
    let commit = ''
    if (!ref) {
      ref = github.context.ref
      commit = github.context.sha

      // Some events have an unqualifed ref. For example when a PR is merged (pull_request closed event),
      // the ref is unqualifed like "main" instead of "refs/heads/main".
      if (commit && ref && !ref.startsWith('refs/')) {
        ref = `refs/heads/${ref}`
      }
    } else if (ref.match(/^[0-9a-fA-F]{40}$/)) {
      // SHA
      commit = ref
      ref = ''
    }
    core.debug(`Ref ${ref}`)
    core.debug(`Commit ${commit}`)

    const token = core.getInput('token')
    const fetchDepth = Number(core.getInput('fetch-depth'))
    core.debug(`Depth ${fetchDepth}`)

    const repoPath = core.getInput('path')
    core.debug(`Path ${repoPath}`)

    const gitMirrorPath = process.env['NSC_GIT_MIRROR']
    core.debug(`Git mirror path ${gitMirrorPath}`)
    if (!gitMirrorPath || !fs.existsSync(gitMirrorPath)) {
      throw new Error(`Experimental git mirror feature must be enabled.`)
    }

    const workspacePath = process.env['GITHUB_WORKSPACE']
    core.debug(`Workspace path ${workspacePath}`)
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      throw new Error(
        `GitHub Runner workspace is not set GITHUB_WORKSPACE = ${workspacePath}.`
      )
    }

    // Set authentication
    const basicCredential = Buffer.from(
      `x-access-token:${token}`,
      'utf8'
    ).toString('base64')

    await exec.exec(
      `git config --global --add http.https://github.com/.extraheader "AUTHORIZATION: basic ${basicCredential}"`
    )

    // Prepare mirror if does not exist
    const mirrorDir = path.join(gitMirrorPath, `${owner}-${repo}`)
    if (!fs.existsSync(mirrorDir)) {
      fs.mkdirSync(mirrorDir)
      await exec.exec(
        `git clone --mirror -- https://token@github.com/${owner}/${repo}.git ${mirrorDir}`
      )
    }

    // Fetch commits for mirror
    await exec.exec(`git --git-dir ${mirrorDir} fetch --no-recurse-submodules`)

    // Prepare repo dir
    let repoDir = workspacePath
    if (repoPath) {
      repoDir = path.join(workspacePath, repoPath)
    }

    // Clone the repo
    await exec.exec(`git config --global --add safe.directory ${repoDir}`)
    if (fetchDepth <= 0) {
      await exec.exec(
        `git clone --reference ${mirrorDir} -- https://token@github.com/${owner}/${repo}.git ${repoDir}`
      )
    } else {
      await exec.exec(
        `git clone --reference ${mirrorDir} --depth=${fetchDepth} -- https://token@github.com/${owner}/${repo}.git ${repoDir}`
      )
    }

    const checkoutInfo = await getCheckoutInfo(ref, commit)
    if (checkoutInfo.startPoint) {
      await exec.exec(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} checkout --progress --force -B ${checkoutInfo.ref} ${checkoutInfo.startPoint}`
      )
    } else {
      await exec.exec(
        `git --git-dir ${repoDir}/.git --work-tree ${repoDir} checkout --progress --force ${checkoutInfo.ref}`
      )
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

export interface ICheckoutInfo {
  ref: string
  startPoint: string
}

export async function getCheckoutInfo(
  ref: string,
  commit: string
): Promise<ICheckoutInfo> {
  if (!ref && !commit) {
    throw new Error('Args ref and commit cannot both be empty')
  }

  const result = {} as unknown as ICheckoutInfo
  const upperRef = (ref || '').toUpperCase()

  // SHA only
  if (!ref) {
    result.ref = commit
  }
  // refs/heads/
  else if (upperRef.startsWith('REFS/HEADS/')) {
    const branch = ref.substring('refs/heads/'.length)
    result.ref = branch
    result.startPoint = `refs/remotes/origin/${branch}`
  }
  // refs/pull/
  else if (upperRef.startsWith('REFS/PULL/')) {
    const branch = ref.substring('refs/pull/'.length)
    result.ref = `refs/remotes/pull/${branch}`
  }
  // refs/tags/
  else if (upperRef.startsWith('REFS/')) {
    result.ref = ref
  }

  return result
}
