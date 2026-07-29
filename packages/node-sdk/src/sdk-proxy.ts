/**
 * SDK-local proxy dispatcher helper — wraps the v2 implementation so the SDK
 * barrel can drop the legacy `@moonshot-ai/agent-core` dependency.
 *
 * The v2 `_base/utils/proxy` module is the canonical owner; this thin module
 * re-exports it from the SDK for Node.js processes that need process-wide HTTP
 * proxy support.
 *
 * Only Node.js hosts need this — Web and Desktop use the OS / browser proxy
 * settings instead.
 */

export { installGlobalProxyDispatcher } from '@moonshot-ai/agent-core-v2/_base/utils/proxy';
