import { OPERATOR_WRITE_PERMISSION } from './operator-jobs-types.ts';
import { NativeOperatorPermissions, OPERATOR_PERMISSION_LIMITS } from './operator-permission.ts';

export const OPERATOR_WRITE_PERMISSION_LIMITS = { ...OPERATOR_PERMISSION_LIMITS };
export const OPERATOR_WRITE_NONCE = 'onionsoupWriteNonce';

/** Each write scope and reviewed-diff acceptance needs its own exact native Allow once response. */
export class OperatorWritePermissions extends NativeOperatorPermissions {
  constructor(limits = OPERATOR_WRITE_PERMISSION_LIMITS) {
    super({ permission: OPERATOR_WRITE_PERMISSION, errorPrefix: 'operator_write', nonceKey: OPERATOR_WRITE_NONCE }, limits);
  }
}
