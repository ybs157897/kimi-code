// apps/kimi-web/src/api/daemon/wire.ts
// Daemon wire DTOs — ALL fields stay snake_case as they appear on the wire.
// No camelCase conversions here; that is mappers.ts's job.
//
// Barrel over the domain-grouped wire DTO modules (wire*.ts) — consumers keep
// importing the full public type set from this path.

export * from './wireEnvelope';
export * from './wireSession';
export * from './wireWorkspace';
export * from './wireMessage';
export * from './wirePrompt';
export * from './wireApproval';
export * from './wireQuestion';
export * from './wireTask';
export * from './wireFs';
export * from './wireModel';
export * from './wireAuth';
export * from './wireUpload';
export * from './wireWsFrames';
export * from './wireWsSync';
export * from './wireWsEvents';
export * from './wireExpertTeam';
