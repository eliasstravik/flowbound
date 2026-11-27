// What "flowbound" means inside a workflow function. The body of a "use workflow" function only decides what
// happens in which order; anything that touches the world (a provider, the records, a model) belongs in a step.
export function use(name: string): never {
  throw new Error(`use("${name}") works inside a step. Move this code into a function that starts with "use step".`)
}
