// The oldest Node.js Flowbound runs on. It reads your workflow files as TypeScript, which Node does by itself from 22.18.
// Kept to the plainest JavaScript, so it can still speak on a Node that is far too old for the rest.

export const NEEDS = "22.18"

/** What to say when this Node is too old, or nothing when it is new enough. `version` is like "v20.11.0". */
export function tooOld(version: string): string | undefined {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number)
  const [needMajor = 0, needMinor = 0] = NEEDS.split(".").map(Number)
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return undefined
  return [
    `Flowbound needs Node.js ${NEEDS} or newer. This computer has Node.js ${version.replace(/^v/, "")}.`,
    "",
    "Get the newest Node.js (the LTS one) from https://nodejs.org, or with a version manager:",
    "  nvm install --lts      (nvm, on Mac and Linux)",
    "  fnm install --lts      (fnm)",
    "  volta install node     (Volta)",
    "",
    "Then open a new terminal and run the same command again. `node -v` shows the version you have.",
  ].join("\n")
}
