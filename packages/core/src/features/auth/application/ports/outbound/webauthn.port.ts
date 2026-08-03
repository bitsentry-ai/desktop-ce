import type {
  WebAuthnPublicKeyCredentialCreationOptions,
  WebAuthnPublicKeyCredentialRequestOptions,
  WebAuthnRegistrationResponse,
  WebAuthnAuthenticationResponse,
  RegistrationVerificationResult,
  AuthenticationVerificationResult,
} from '../../../contracts/webauthn.types';

/**
 * Options for generating registration options
 */
type WebAuthnUserVerification = 'required' | 'preferred' | 'discouraged';

export interface WebAuthnGenerateRegistrationInput {
  readonly rpName: string;
  readonly rpId: string;
  readonly userId: string; // Encoded user ID
  readonly userName: string;
  readonly userDisplayName: string;
  readonly excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  readonly timeout?: number;
  readonly attestationType?: 'none' | 'indirect' | 'direct' | 'enterprise';
  readonly authenticatorSelection?: {
    residentKey?: 'required' | 'preferred' | 'discouraged';
    userVerification?: WebAuthnUserVerification;
  };
}

/**
 * Options for generating authentication options
 */
export interface WebAuthnGenerateAuthenticationInput {
  readonly rpId: string;
  readonly allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  readonly userVerification?: 'required' | 'preferred' | 'discouraged';
  readonly timeout?: number;
}

/**
 * Options for verifying registration response
 */
export interface WebAuthnVerifyRegistrationInput {
  readonly response: WebAuthnRegistrationResponse;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
}

/**
 * Options for verifying authentication response
 */
export interface WebAuthnVerifyAuthenticationInput {
  readonly response: WebAuthnAuthenticationResponse;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly requireUserVerification?: boolean;
  readonly credential: {
    id: string;
    publicKey: Uint8Array;
    counter: number;
    transports?: string[];
  };
}

/**
 * Port for WebAuthn operations.
 * Wraps library-specific WebAuthn implementations (e.g., @simplewebauthn/server).
 */
export interface WebAuthnPort {
  /**
   * Generate registration options for passkey creation
   */
  generateRegistrationOptions(
    input: WebAuthnGenerateRegistrationInput,
  ): Promise<WebAuthnPublicKeyCredentialCreationOptions>;

  /**
   * Verify a registration response from the client
   */
  verifyRegistrationResponse(
    input: WebAuthnVerifyRegistrationInput,
  ): Promise<RegistrationVerificationResult>;

  /**
   * Generate authentication options for passkey login
   */
  generateAuthenticationOptions(
    input: WebAuthnGenerateAuthenticationInput,
  ): Promise<WebAuthnPublicKeyCredentialRequestOptions>;

  /**
   * Verify an authentication response from the client
   */
  verifyAuthenticationResponse(
    input: WebAuthnVerifyAuthenticationInput,
  ): Promise<AuthenticationVerificationResult>;
}
