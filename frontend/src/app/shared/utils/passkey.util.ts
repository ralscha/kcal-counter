function bufferToBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(
          (buffer as ArrayBufferView).buffer,
          (buffer as ArrayBufferView).byteOffset,
          (buffer as ArrayBufferView).byteLength,
        );
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function supportsImmediateMediation(): Promise<boolean> {
  try {
    const PKC = PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
    };
    const caps = await PKC.getClientCapabilities?.();
    return caps?.['immediateGet'] === true;
  } catch {
    return false;
  }
}

export function prepareCreationOptions(
  raw: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return PublicKeyCredential.parseCreationOptionsFromJSON(raw);
}

export function prepareAssertionOptions(
  raw: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return PublicKeyCredential.parseRequestOptionsFromJSON(raw);
}

export function serializeAttestationCredential(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const resp = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(resp.clientDataJSON),
      attestationObject: bufferToBase64url(resp.attestationObject),
      transports: resp.getTransports?.() ?? [],
    },
  };
}

export function serializeAssertionCredential(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const resp = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bufferToBase64url(resp.authenticatorData),
      clientDataJSON: bufferToBase64url(resp.clientDataJSON),
      signature: bufferToBase64url(resp.signature),
      userHandle: resp.userHandle ? bufferToBase64url(resp.userHandle) : null,
    },
  };
}
