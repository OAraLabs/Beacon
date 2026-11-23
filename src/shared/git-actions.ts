// The git action buttons in the Git panel: Commit, Start a branch, Push, Open a pull request.
//
// A BUTTON HERE DOES NOT DO GIT. It puts a prepared request into the conversation's message box,
// in words, and the person sends it like anything they type. What the assistant then does, it does
// with its own tools, through the same approval gate as everything else it does: Beacon has no
// path of its own that stages, commits, branches, pushes or opens anything. Whether a push is
// "critical" (answered only on its full card) is the daemon's call, never Beacon's.
//
// So the prompts are FIXED TEXT. Nothing read from the folder (a branch name, a file name, a
// commit subject: all written by whoever wrote the repository, the assistant included) is ever
// put into one: that would be the repository speaking in the person's voice. Which buttons are
// offered depends on the state, never the words.
import type { GitPrRead } from './git-pr'
import type { GitRead } from './git-state'

export type GitActionId = 'commit' | 'branch' | 'push' | 'pr'

export interface GitAction {
  id: GitActionId
  /** The button. */
  label: string
  /** What it will ask, in a sentence, for the tooltip. */
  hint: string
  /** The words put in the message box. */
  prompt: string
}

const ACTIONS: Record<GitActionId, GitAction> = {
  commit: {
    id: 'commit',
    label: 'Commit these changes',
    hint: 'Asks your assistant to commit what has changed, without pushing',
    prompt: 'Look at what has changed with git status and git diff. Stage only the files that belong to this work, by name (not git add -A or git add .), and skip ignored files, secrets and build output. Then commit with a clear message of what changed and why. Don\u2019t amend, don\u2019t skip hooks, don\u2019t push.'
  },
  branch: {
    id: 'branch',
    label: 'Start a new branch',
    hint: 'Asks your assistant to start a branch for this work, without pushing',
    prompt: 'Start a new branch for this work: pick a short, descriptive name, create it and switch to it, keeping whatever has changed. Don\u2019t stash, reset, discard or delete anything, and don\u2019t push. Tell me the name.'
  },
  push: {
    id: 'push',
    label: 'Push this branch',
    hint: 'Asks your assistant to push the branch; you will be asked to approve it like anything else it does',
    prompt: 'Push the current branch to a remote branch of the same name (git push -u origin HEAD). If its upstream has a different name, or there is more than one remote, stop and ask me. Never push to main or master. Don\u2019t force-push. Tell me what was pushed.'
  },
  pr: {
    id: 'pr',
    label: 'Open a pull request',
    hint: 'Asks your assistant to open a pull request for the branch, which must already be pushed',
    prompt: 'Open a pull request for the current branch on the remote it tracks, against that repository\u2019s default base branch, using gh. The branch must already be pushed; if it isn\u2019t, or gh is missing, stop and tell me. Don\u2019t push. Write a clear title and a short description from this branch\u2019s commits, and tell me the link.'
  }
}

/** Branches a person does not usually push to or open a pull request from, compared without regard
 *  to case. A button is not offered there: asking for either is one sentence of their own. */
const isDefaultBranch = (name: string): boolean => /^(main|master)$/i.test(name)

/** Whether the upstream is the same-named branch on a remote (`origin/feat/x` for `feat/x`). A
 *  branch tracking something else (`feature` tracking `origin/main`) would be pushed to that
 *  other name by some git settings, and a repository's own settings are not the person's. */
const upstreamIsOwn = (branch: string, upstream: string): boolean => upstream.endsWith(`/${branch}`) && upstream.length > branch.length + 1

/**
 * The buttons to offer for what git says, in the order they are usually wanted. None when the
 * folder could not be read or is not a repository.
 *
 *  - Commit: there are changed files, none in conflict, and nothing under way (a merge, a rebase).
 *  - Start a new branch: always, in a repository.
 *  - Push: on a named branch other than main or master, with a commit, nothing under way and no
 *    conflict, and either no upstream yet or, for an upstream of the same name, commits it lacks.
 *  - Open a pull request: on such a branch whose same-named upstream has everything (nothing
 *    ahead), with no pull request known for it. While "could not be told just now" is the answer,
 *    none is offered (it may already have one).
 */
export function gitActions(read: GitRead | null | undefined, pr?: GitPrRead | null): GitAction[] {
  if (!read || read.kind !== 'state') return []
  const s = read.state
  const out: GitAction[] = []
  if (s.changed > 0 && s.conflicted === 0 && s.operation === null) out.push(ACTIONS.commit)
  out.push(ACTIONS.branch)
  const named = s.branch !== null && s.commit !== null && !isDefaultBranch(s.branch) && s.operation === null && s.conflicted === 0
  const branch = s.branch ?? ''
  const own = s.upstream !== null && named && upstreamIsOwn(branch, s.upstream)
  if (named && (s.upstream === null || (own && (s.ahead ?? 0) > 0))) out.push(ACTIONS.push)
  if (own && s.ahead === 0 && pr?.kind !== 'pr' && pr?.kind !== 'unknown') out.push(ACTIONS.pr)
  return out
}

/** Every prompt there is, for the smoke: they are constants, and this is the whole list. */
export const GIT_ACTION_PROMPTS: Readonly<Record<GitActionId, string>> = Object.freeze({
  commit: ACTIONS.commit.prompt,
  branch: ACTIONS.branch.prompt,
  push: ACTIONS.push.prompt,
  pr: ACTIONS.pr.prompt
})

/** What the panel says under the buttons. */
export const GIT_ACTIONS_NOTE = 'Fills the message box with a request; you send it. What your assistant does then goes through the usual approvals.'
