/**
 * Passkey domain entity
 */
export interface Passkey {
  readonly id: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly deviceName: string | null;
  readonly aaguid: string | null;
  readonly transports: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly userId: number | string;
}

/**
 * Relying Party configuration for WebAuthn
 */
export interface WebAuthnRelyingParty {
  readonly name: string;
  readonly id: string;
  readonly origin: string;
}

/**
 * WebAuthn registration options input
 */
export interface GenerateRegistrationOptionsInput {
  readonly userId: number | string;
  readonly userEmail: string | null;
  readonly userDisplayName: string;
  readonly existingPasskeys: Passkey[];
  readonly rpName: string;
  readonly rpId: string;
  readonly deviceName?: string;
}

/**
 * WebAuthn registration options result
 */
export interface RegistrationOptionsResult {
  readonly registrationOptions: WebAuthnPublicKeyCredentialCreationOptions;
  readonly challengeId: string;
  readonly expiresIn: number;
}

/**
 * WebAuthn authentication options input
 */
type WebAuthnUserVerification = 'required' | 'preferred' | 'discouraged';

export interface GenerateAuthenticationOptionsInput {
  readonly rpId: string;
  readonly allowedPasskeys?: Passkey[];
  readonly userVerification?: WebAuthnUserVerification;
}

/**
 * WebAuthn authentication options result
 */
export interface AuthenticationOptionsResult {
  readonly authenticationOptions: WebAuthnPublicKeyCredentialRequestOptions;
  readonly challengeId: string;
  readonly expiresIn: number;
}

/**
 * Simplified WebAuthn credential creation options (framework-agnostic)
 */
export interface WebAuthnPublicKeyCredentialCreationOptions {
  readonly challenge: string;
  readonly rp: { name: string; id: string };
  readonly user: { id: string; name: string; displayName: string };
  readonly pubKeyCredParams: { type: 'public-key'; alg: number }[];
  readonly timeout?: number;
  readonly excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  readonly authenticatorSelection?: {
    residentKey?: WebAuthnUserVerification;
    userVerification?: 'required' | 'preferred' | 'discouraged';
  };
  readonly attestation?: 'none' | 'indirect' | 'direct' | 'enterprise';
}

/**
 * Simplified WebAuthn credential request options (framework-agnostic)
 */
export interface WebAuthnPublicKeyCredentialRequestOptions {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout?: number;
  readonly allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  readonly userVerification?: 'required' | 'preferred' | 'discouraged';
}

/**
 * WebAuthn registration response from client
 */
export interface WebAuthnRegistrationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: string[];
  };
  readonly clientExtensionResults?: Record<string, unknown>;
  readonly authenticatorAttachment?: 'platform' | 'cross-platform';
}

/**
 * WebAuthn authentication response from client
 */
export interface WebAuthnAuthenticationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: 'public-key';
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string | null;
  };
  readonly clientExtensionResults?: Record<string, unknown>;
  readonly authenticatorAttachment?: 'platform' | 'cross-platform';
}

/**
 * Verify registration input
 */
export interface VerifyRegistrationInput {
  readonly challengeId: string;
  readonly response: WebAuthnRegistrationResponse;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly deviceName?: string;
}

/**
 * Verify authentication input
 */
export interface VerifyAuthenticationInput {
  readonly challengeId: string;
  readonly response: WebAuthnAuthenticationResponse;
  readonly expectedChallenge: string;
  readonly expectedOrigin: string;
  readonly expectedRpId: string;
  readonly passkey: Passkey;
}

/**
 * Registration verification result
 */
export interface RegistrationVerificationResult {
  readonly verified: boolean;
  readonly credential?: {
    readonly id: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly transports?: string[];
  };
  readonly aaguid?: string;
}

/**
 * Authentication verification result
 */
export interface AuthenticationVerificationResult {
  readonly verified: boolean;
  readonly newCounter?: number;
}

/**
 * Passkey list item for display
 */
export interface PasskeyListItem {
  readonly id: string;
  readonly deviceName: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly isActive: boolean;
}

/**
 * Challenge cache data
 */
export interface WebAuthnChallengeData {
  readonly challenge: string;
  readonly userId: number | string | null;
  readonly deviceName?: string;
  readonly timestamp: number;
}

/**
 * Authenticator type detection
 */
export type AuthenticatorType = 'platform' | 'cross-platform' | 'unknown';
