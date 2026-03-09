"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";

export interface AuthUser {
  peerId: string;
  publicKey: string;
  username?: string;
  isClaimed: boolean;
  balance: number;
  /** Phase 86: Always 'jwt' — all auth is JWT-based now */
  authMethod?: "jwt";
}

export interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  isGuest: boolean;
  isClaimed: boolean;
  login: (identifier: string, password: string) => Promise<{ success: boolean; error?: string }>;
  claim: (password: string, username?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  token: string | null;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  isGuest: false,
  isClaimed: false,
  login: async () => ({ success: false, error: "Not initialized" }),
  claim: async () => ({ success: false, error: "Not initialized" }),
  logout: async () => {},
  token: null,
});

export function useAuth(): AuthContextType {
  return useContext(AuthContext);
}

const TOKEN_KEY = "pando_token";

/**
 * Phase 86: Perform Ed25519 challenge-response authentication with stateless JWT tokens.
 * 1. POST /api/auth/challenge with peerId → get { challengeToken, nonce }
 * 2. Sign the nonce with the private key
 * 3. POST /api/auth/verify with { peerId, challengeToken, signature } → get JWT
 * Challenge and verify can hit DIFFERENT nodes — both are stateless.
 */
async function signatureAuth(peerId: string): Promise<{
  token: string;
  expiresAt: number;
  peerId: string;
} | null> {
  try {
    const { getPrivateKey, signChallenge } = await import("@/lib/crypto");

    const privateKey = getPrivateKey(peerId);
    if (!privateKey) return null;

    // Step 1: Request challenge — returns signed challenge token + nonce
    const challengeRes = await fetch("/api/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId }),
    });
    if (!challengeRes.ok) return null;
    const { challengeToken, nonce } = await challengeRes.json();
    if (!challengeToken || !nonce) return null;

    // Step 2: Sign the NONCE (not the challenge token)
    const signature = signChallenge(nonce, privateKey);

    // Step 3: Verify — send challengeToken + user signature → get JWT
    const verifyRes = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId, challengeToken, signature }),
    });
    if (!verifyRes.ok) return null;
    const result = await verifyRes.json();
    if (!result.token) return null;

    return result;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Track the peerId used for signature auth so we can auto-refresh. */
  const sigAuthPeerIdRef = useRef<string | null>(null);

  /** Store token in both state and localStorage. */
  const saveToken = useCallback((t: string | null) => {
    setToken(t);
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }, []);

  /** Phase 86: Schedule auto-refresh for JWT tokens (1 hour before 24h expiry). */
  const scheduleRefresh = useCallback(
    (expiresAt: number, peerId: string) => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      // Refresh 1 hour before expiry (JWTs are 24h, not 15min)
      const refreshIn = Math.max(expiresAt - Date.now() - 3_600_000, 60_000);
      refreshTimerRef.current = setTimeout(async () => {
        const result = await signatureAuth(peerId);
        if (result) {
          saveToken(result.token);
          scheduleRefresh(result.expiresAt, peerId);
        }
        // If refresh fails, the next API call will get 401 and user can re-auth
      }, refreshIn);
    },
    [saveToken],
  );

  /** Try to validate an existing token via GET /api/auth/me.
   * Returns 'valid' | 'invalid' | 'error' to distinguish genuinely expired tokens
   * from transient network failures (D#176 fix).
   */
  const validateToken = useCallback(async (t: string): Promise<'valid' | 'invalid' | 'error'> => {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.status === 401) return 'invalid';
      if (!res.ok) return 'error';
      const data = await res.json();
      if (data.user) {
        setUser({
          peerId: data.user.peerId,
          publicKey: data.user.publicKey,
          username: data.user.username || undefined,
          isClaimed: data.user.isClaimed,
          balance: data.user.balance ?? 0,
          authMethod: "jwt",
        });
        return 'valid';
      }
      return 'invalid';
    } catch {
      return 'error';
    }
  }, []);

  /** Create a new guest session with browser-side key generation. */
  const createGuest = useCallback(async (): Promise<boolean> => {
    try {
      // Phase 41: Generate keypair in the browser — private key never leaves
      const { generateKeyPair, storePrivateKey } = await import("@/lib/crypto");
      const { privateKey, publicKey } = generateKeyPair();
      const publicKeyBase64 = btoa(String.fromCharCode(...publicKey));

      const res = await fetch("/api/auth/guest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: publicKeyBase64 }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.success && data.token && data.peerId) {
        // Store private key in browser localStorage (keyed by peerId from node)
        storePrivateKey(data.peerId, privateKey);
        saveToken(data.token);
        sigAuthPeerIdRef.current = data.peerId;
        // Phase 86: Schedule JWT refresh (response includes expiresAt)
        if (data.expiresAt) {
          scheduleRefresh(data.expiresAt, data.peerId);
        }
        setUser({
          peerId: data.peerId,
          publicKey: publicKeyBase64,
          username: undefined,
          isClaimed: false,
          balance: 0,
          authMethod: "jwt",
        });
        return true;
      }
      return false;
    } catch (err) {
      console.error("[auth] Browser key generation failed:", err);
      return false;
    }
  }, [saveToken, scheduleRefresh]);

  /** Try signature-based auth using a stored private key. */
  const trySignatureAuth = useCallback(async (): Promise<boolean> => {
    try {
      const { getStoredPeerId } = await import("@/lib/crypto");
      const peerId = getStoredPeerId();
      if (!peerId) return false;

      const result = await signatureAuth(peerId);
      if (!result) return false;

      saveToken(result.token);
      sigAuthPeerIdRef.current = peerId;

      // Validate the token to populate user info
      const validationResult = await validateToken(result.token);
      if (validationResult === 'valid') {
        scheduleRefresh(result.expiresAt, peerId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [saveToken, validateToken, scheduleRefresh]);

  /** Initialize auth on mount. */
  useEffect(() => {
    async function init() {
      // 1. Try existing stored token
      const existingToken = localStorage.getItem(TOKEN_KEY);
      if (existingToken) {
        const result = await validateToken(existingToken);
        if (result === 'valid') {
          setToken(existingToken);
          setLoading(false);
          return;
        }
        if (result === 'error') {
          // Network error — keep token, assume still valid (D#176)
          setToken(existingToken);
          setLoading(false);
          return;
        }
        // result === 'invalid' — token is genuinely expired/bad
        localStorage.removeItem(TOKEN_KEY);
      }

      // 2. Try signature-based auth if we have a stored private key
      const sigAuthOk = await trySignatureAuth();
      if (sigAuthOk) {
        setLoading(false);
        return;
      }

      // 3. Fall back to creating a guest session
      await createGuest();
      setLoading(false);
    }
    init();

    // Cleanup refresh timer on unmount
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [validateToken, createGuest, trySignatureAuth]);

  /** Login with identifier (username or peerId) and password.
   * Phase 41.5: After login, try to restore the private key from the encrypted backup.
   * Flow: login -> get session token -> fetch backup -> decrypt with password -> store in localStorage -> signature auth.
   */
  const login = useCallback(async (identifier: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      // Step 1: Login with username+password to get a session token
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || "Login failed" };
      }
      saveToken(data.token);

      // Step 2: Try to restore private key from encrypted backup
      try {
        const { storePrivateKey, decryptPrivateKeyWithPassword } = await import("@/lib/crypto");
        const backupRes = await fetch("/api/auth/backup-key", {
          headers: { Authorization: `Bearer ${data.token}` },
        });
        if (backupRes.ok) {
          const backupData = await backupRes.json();
          if (backupData.encryptedKey) {
            // Step 3: Decrypt private key with password and store in localStorage
            const privateKey = await decryptPrivateKeyWithPassword(backupData.encryptedKey, password);
            storePrivateKey(data.peerId, privateKey);

            // Step 4: Do signature auth for a proper signature-based token
            const sigResult = await signatureAuth(data.peerId);
            if (sigResult) {
              saveToken(sigResult.token);
              sigAuthPeerIdRef.current = data.peerId;
              // Fetch actual user balance from /api/auth/me
              let sigBalance = 0;
              try {
                const meRes2 = await fetch("/api/auth/me", {
                  headers: { Authorization: `Bearer ${sigResult.token}` },
                });
                if (meRes2.ok) {
                  const meData2 = await meRes2.json();
                  sigBalance = meData2.user?.balance ?? 0;
                }
              } catch {}
              setUser({
                peerId: data.peerId,
                publicKey: data.publicKey,
                username: data.username || undefined,
                isClaimed: true,
                balance: sigBalance,
                authMethod: "jwt",
              });
              scheduleRefresh(sigResult.expiresAt, data.peerId);
              return { success: true };
            }
          }
        }
      } catch (backupErr) {
        // Non-fatal -- private key restore failed, but login still works with session auth
        console.warn("[auth] Private key restore from backup failed:", backupErr);
      }

      // Fallback: session-based auth (no private key available on this device)
      sigAuthPeerIdRef.current = null;
      // Fetch actual user balance from /api/auth/me
      let userBalance = 0;
      try {
        const meRes = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${data.token}` },
        });
        if (meRes.ok) {
          const meData = await meRes.json();
          userBalance = meData.user?.balance ?? 0;
        }
      } catch {}
      setUser({
        peerId: data.peerId,
        publicKey: data.publicKey,
        username: data.username || undefined,
        isClaimed: true,
        balance: userBalance,
        authMethod: "jwt",
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || "Network error" };
    }
  }, [saveToken, scheduleRefresh]);

  /** Claim a guest account (upgrade to permanent).
   * Phase 41.5: After claiming, encrypt the private key with the password and back it up.
   */
  const claim = useCallback(async (password: string, username?: string): Promise<{ success: boolean; error?: string }> => {
    const currentToken = token || localStorage.getItem(TOKEN_KEY);
    if (!currentToken) {
      return { success: false, error: "No active session" };
    }
    try {
      const body: Record<string, string> = { password };
      if (username) body.username = username;

      const res = await fetch("/api/auth/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || "Claim failed" };
      }
      // Update token if a new one was issued
      const activeToken = data.token || currentToken;
      if (data.token) {
        saveToken(data.token);
      }

      // Phase 41.5: Backup the private key encrypted with the password
      try {
        const { getPrivateKey, encryptPrivateKeyWithPassword } = await import("@/lib/crypto");
        const privateKey = getPrivateKey(data.peerId);
        if (privateKey) {
          const encryptedKey = await encryptPrivateKeyWithPassword(privateKey, password);
          await fetch("/api/auth/backup-key", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${activeToken}`,
            },
            body: JSON.stringify({ encryptedKey }),
          });
        }
      } catch (backupErr) {
        // Non-fatal -- claim succeeded, but backup failed
        console.warn("[auth] Private key backup after claim failed:", backupErr);
      }

      setUser({
        peerId: data.peerId,
        publicKey: data.publicKey,
        username: data.username || undefined,
        isClaimed: true,
        balance: user?.balance ?? 0,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || "Network error" };
    }
  }, [token, saveToken, user]);

  /** Logout — clear session, clear signature auth state, create new guest, redirect to /login. */
  const logout = useCallback(async () => {
    const currentToken = token || localStorage.getItem(TOKEN_KEY);
    if (currentToken) {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${currentToken}` },
        });
      } catch {
        // Ignore — clear local state anyway
      }
    }
    // Clear refresh timer
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    sigAuthPeerIdRef.current = null;
    saveToken(null);
    setUser(null);
    // Create a new guest session
    await createGuest();
    // Redirect to login page
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }, [token, saveToken, createGuest]);

  const isGuest = !!user && !user.isClaimed;
  const isClaimed = !!user && user.isClaimed;

  return (
    <AuthContext.Provider value={{ user, loading, isGuest, isClaimed, login, claim, logout, token }}>
      {children}
    </AuthContext.Provider>
  );
}
