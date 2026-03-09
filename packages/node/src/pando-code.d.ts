/**
 * Type stub for @pando-code/core.
 * The actual module is loaded dynamically at runtime via `await import()`.
 * This declaration prevents TS2307 on machines where @pando-code/core
 * is not installed (e.g. EC2 compute nodes).
 */
declare module '@pando-code/core' {
  export const EnginePool: any;
  export const Scheduler: any;
  export const PandoCode: any;
  export function createCheckAgentsTool(opts: any): any;
  export function createSendMessageTool(opts: any): any;
  export function createManageTasksTool(opts: any): any;
  const _default: any;
  export default _default;
}
