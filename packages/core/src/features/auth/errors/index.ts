import { CoreError } from '../../../kernel';

/**
 * Base class for all auth-related errors
 */
export abstract class AuthError extends CoreError {
  constructor(
    code: string,
    message: string,
    public readonly field?: string,
  ) {
    super(code, message);
  }
}
