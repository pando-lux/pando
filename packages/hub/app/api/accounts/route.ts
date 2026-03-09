import { NextResponse } from "next/server";
import {
  registerAccount,
  getAccount,
  updateAccount,
  deleteAccountServer,
} from "@/lib/account-store";

// POST — register a new account (store encrypted key on server)
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { username, publicKey, encryptedPrivateKey, salt, iv, createdAt } =
      body;

    if (!username || !publicKey || !encryptedPrivateKey || !salt || !iv) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const success = registerAccount({
      username,
      publicKey,
      encryptedPrivateKey,
      salt,
      iv,
      createdAt: createdAt || Date.now(),
    });

    if (!success) {
      return NextResponse.json(
        { error: "Username already taken" },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, username });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

// GET — fetch encrypted account data by username (for sign-in from any device)
export async function GET(request: Request) {
  const url = new URL(request.url);
  const username = url.searchParams.get("username");

  if (!username) {
    return NextResponse.json(
      { error: "Username is required" },
      { status: 400 }
    );
  }

  const account = getAccount(username);
  if (!account) {
    return NextResponse.json(
      { error: "Account not found" },
      { status: 404 }
    );
  }

  // Return the encrypted data — browser will decrypt with password
  return NextResponse.json({
    username: account.username,
    publicKey: account.publicKey,
    encryptedPrivateKey: account.encryptedPrivateKey,
    salt: account.salt,
    iv: account.iv,
    createdAt: account.createdAt,
  });
}

// PATCH — update encrypted key (after password change)
export async function PATCH(request: Request) {
  try {
    const { username, encryptedPrivateKey, salt, iv } = await request.json();
    if (!username || !encryptedPrivateKey || !salt || !iv) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const success = updateAccount(username, { encryptedPrivateKey, salt, iv });
    if (!success) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

// DELETE — delete account from server
export async function DELETE(request: Request) {
  try {
    const { username } = await request.json();
    if (!username) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    const success = deleteAccountServer(username);
    if (!success) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
