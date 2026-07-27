import type {
  TUIApprovalRequest,
  TUIApprovalResponse,
} from '#/tui/runtime/session-events-port';

import { adaptApprovalRequest } from './adapter';
import type { ApprovalController } from './controller';

export interface TUIApprovalRequestHandler {
  <GenericDetail>(
    request: TUIApprovalRequest<GenericDetail>,
  ): Promise<TUIApprovalResponse>;
}

export interface TUIApprovalResponseObserver {
  <GenericDetail>(
    request: TUIApprovalRequest<GenericDetail>,
    response: TUIApprovalResponse,
  ): void;
}

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: TUIApprovalResponseObserver,
): TUIApprovalRequestHandler {
  return async <GenericDetail>(
    event: TUIApprovalRequest<GenericDetail>,
  ): Promise<TUIApprovalResponse> => {
    try {
      const response = await controller.show(adaptApprovalRequest(event));
      onResponse?.(event, response);
      return response;
    } catch {
      const response: TUIApprovalResponse = {
        decision: 'cancelled',
        feedback: 'approval handler failed',
      };
      onResponse?.(event, response);
      return response;
    }
  };
}
