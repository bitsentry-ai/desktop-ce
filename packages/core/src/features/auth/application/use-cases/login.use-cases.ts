import type {
  LoginUseCases,
  LoginInput,
  Complete2FAInput,
  SocialLoginInput,
  TokenUseCases,
} from "../ports/inbound";
import type {
  AuthUserRepositoryPort,
  AuthSessionPort,
  PasswordHasherPort,
  AuthSettingsPort,
  TotpPort,
} from "../ports/outbound";
import type {
  LoginResult,
  TwoFARequiredResult,
  AuthUser,
  TwoFAMethod,
} from "../../contracts/auth.types";
import { TWO_FA_METHODS } from "../../auth.constants";
import {
  UserNotFoundError,
  WrongProviderError,
  NoPasswordSetError,
  InvalidPasswordError,
  AccountInactiveError,
  EmailNotConfirmedError,
  InvalidTempTokenError,
  TotpNotEnabledError,
  InvalidTotpTokenError,
  Invalid2FAMethodError,
} from "../../errors";

// Status enum values (should match backend)
const StatusEnum = {
  active: 1,
  inactive: 2,
} as const;

// Role IDs that bypass OTP (for test accounts)
const OTP_BYPASS_ROLE_IDS = new Set([99]);

/**
 * Login use cases implementation.
 * Handles email/password login, 2FA verification, and social login.
 */
export class LoginUseCasesImpl implements LoginUseCases {
  constructor(
    private readonly userRepository: AuthUserRepositoryPort,
    private readonly sessionPort: AuthSessionPort,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly tokenUseCases: TokenUseCases,
    private readonly totpPort: TotpPort,
    private readonly settingsPort: AuthSettingsPort,
  ) {}

  async validateLogin(input: LoginInput): Promise<LoginResult> {
    const user = await this.validateCredentials(input);
    return this.completeLogin(user.id);
  }

  async validateLoginFor2FA(
    input: LoginInput,
  ): Promise<LoginResult | TwoFARequiredResult> {
    const user = await this.validateCredentials(input);

    const availableMethods = this.availableTwoFaMethods(user);
    const requires2FA =
      !this.userBypassesOtp(user) && availableMethods.length > 0;

    if (!requires2FA) {
      return this.completeLogin(user.id);
    }

    // 2FA required, create temporary token
    const tempToken = await this.tokenUseCases.createTemporaryToken(user.id);

    return {
      requires2FA: true,
      tempToken,
      availableMethods,
      preferredMethod: this.preferredTwoFaMethod(availableMethods),
    };
  }

  async complete2FALogin(input: Complete2FAInput): Promise<LoginResult> {
    const user = await this.userForTemporaryToken(input.tempToken);
    this.verifyTwoFaMethod(input, user);

    return this.completeLogin(user.id);
  }

  async completeLogin(userId: number | string): Promise<LoginResult> {
    const user = await this.userRepository.findById(userId);
    if (user === null) {
      throw new UserNotFoundError();
    }

    // Generate session hash
    const hash = this.generateHash();

    // Create session
    const session = await this.sessionPort.create({
      userId: user.id,
      hash,
    });

    // Generate tokens
    const tokens = await this.tokenUseCases.generateTokens({
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      hash,
    });

    // Update last login
    await this.userRepository.updateLastLogin(user.id);

    return {
      accessToken: tokens.token,
      refreshToken: tokens.refreshToken,
      tokenExpires: tokens.tokenExpires,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        totpEnabled: user.totpEnabled,
        passkeyEnabled: user.passkeyEnabled,
      },
    };
  }

  async validateSocialLogin(input: SocialLoginInput): Promise<LoginResult> {
    // Try to find user by social ID
    // Note: This is a simplified implementation. Full social login requires creating users.
    let user: AuthUser | null = null;
    if (this.userRepository.findBySocialId !== undefined) {
      user = await this.userRepository.findBySocialId(
        input.socialId,
        input.provider,
      );
    }

    if (user === null && input.email !== null && input.email !== undefined) {
      // Try to find by email
      user = await this.userRepository.findByEmail(input.email);
    }

    if (user === null) {
      // Create new user - this would need a createUser method on the repository
      // For now, throw an error indicating user needs to be created
      throw new UserNotFoundError("Social login user not found");
    }

    return this.completeLogin(user.id);
  }

  async logout(sessionId: number): Promise<void> {
    await this.sessionPort.deleteById(sessionId);
  }

  private async validateCredentials(input: LoginInput): Promise<AuthUser> {
    const user = await this.userRepository.findByEmail(input.email);

    if (user === null) {
      throw new UserNotFoundError();
    }

    this.assertEmailPasswordUser(user);

    const isValidPassword = await this.passwordHasher.compare(
      input.password,
      user.password,
    );

    if (!isValidPassword) {
      throw new InvalidPasswordError();
    }

    this.assertLoginStatus(user);

    return user;
  }

  private assertEmailPasswordUser(
    user: AuthUser,
  ): asserts user is AuthUser & { password: string } {
    if (user.provider !== "email") {
      throw new WrongProviderError(user.provider);
    }

    if (user.password === null || user.password.length === 0) {
      throw new NoPasswordSetError();
    }
  }

  private assertLoginStatus(user: AuthUser): void {
    if (user.status === null) {
      throw new EmailNotConfirmedError();
    }

    if (user.status.id === StatusEnum.inactive) {
      throw new AccountInactiveError();
    }

    if (user.status.id !== StatusEnum.active) {
      throw new EmailNotConfirmedError();
    }
  }

  private userBypassesOtp(user: AuthUser): boolean {
    if (user.role === null) return false;
    return OTP_BYPASS_ROLE_IDS.has(Number(user.role.id));
  }

  private availableTwoFaMethods(user: AuthUser): TwoFAMethod[] {
    const methods: TwoFAMethod[] = [];
    if (user.totpEnabled) methods.push(TWO_FA_METHODS.TOTP);
    return methods;
  }

  private preferredTwoFaMethod(methods: TwoFAMethod[]): TwoFAMethod | null {
    if (methods.length === 0) return null;
    return methods[0];
  }

  private async userForTemporaryToken(tempToken: string): Promise<AuthUser> {
    const payload = await this.tokenUseCases.validateTemporaryToken(tempToken);
    if (payload === null) {
      throw new InvalidTempTokenError();
    }

    const user = await this.userRepository.findById(payload.userId);
    if (user === null) {
      throw new UserNotFoundError();
    }

    return user;
  }

  private verifyTwoFaMethod(input: Complete2FAInput, user: AuthUser): void {
    if (input.method === TWO_FA_METHODS.TOTP) {
      this.verifyTotpLogin(input.code, user);
      return;
    }

    // Email OTP verification would be handled by platform.
    throw new Invalid2FAMethodError("Email OTP not implemented in core");
  }

  private verifyTotpLogin(code: string, user: AuthUser): void {
    if (!user.totpEnabled || user.totpSecret === null) {
      throw new TotpNotEnabledError();
    }

    const isValid = this.totpPort.verify({
      token: code,
      secret: user.totpSecret,
    });
    if (!isValid) {
      throw new InvalidTotpTokenError();
    }
  }

  private generateHash(): string {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
