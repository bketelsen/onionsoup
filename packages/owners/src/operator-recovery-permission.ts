import { OPERATOR_RECOVERY_PERMISSION } from './operator-jobs-types.ts';
import { NativeOperatorPermissions, OPERATOR_PERMISSION_LIMITS } from './operator-permission.ts';

export const OPERATOR_RECOVERY_PERMISSION_LIMITS = { ...OPERATOR_PERMISSION_LIMITS };
export const OPERATOR_RECOVERY_NONCE = 'onionsoupRecoveryNonce';

/** Recovery preserves its existing API and error codes while sharing native one-time approval verification. */
export class OperatorRecoveryPermissions extends NativeOperatorPermissions {
  constructor(limits = OPERATOR_RECOVERY_PERMISSION_LIMITS) {
    super({ permission: OPERATOR_RECOVERY_PERMISSION, errorPrefix: 'operator_recovery', nonceKey: OPERATOR_RECOVERY_NONCE }, limits);
  }
}
