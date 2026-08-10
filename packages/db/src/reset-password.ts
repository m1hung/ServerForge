/**
 * Sets a panel account's password from the command line.
 *
 * The way back in when the owner is locked out. Passwords are stored as
 * Argon2id hashes, so a forgotten one cannot be recovered by anybody — and
 * without this the only remedy was editing Postgres by hand, which most people
 * running a self-hosted panel cannot reasonably be asked to do.
 *
 *   npm run reset-password                    # pick an account, prompt twice
 *   npm run reset-password -- --user admin
 *   npm run reset-password -- --user admin --generate
 *
 * Requires shell access to the machine, which is the same thing as being able
 * to read the database — so it grants nothing that was not already available
 * to whoever can run it.
 */
import { hash } from '@node-rs/argon2';
import { passwordSchema } from '@serverforge/core';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../generated/client/index.js';

/** Must match apps/api/src/lib/crypto.ts, or the panel cannot verify the hash. */
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;


const prisma = new PrismaClient();

function parseArgs(argv: string[]) {
  const args = { user: '', generate: false, clearTwoFactor: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--user' || arg === '-u') args.user = argv[++i] ?? '';
    else if (arg === '--generate' || arg === '-g') args.generate = true;
    else if (arg === '--clear-2fa') args.clearTwoFactor = true;
  }
  return args;
}

function ask(question: string, { hidden = false } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    // Nothing echoes a password back. `terminal: true` plus a muted output
    // is the portable way to do that with readline alone.
    const muted = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: unknown };
    process.stdout.write(question);
    muted._writeToOutput = () => undefined;

    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/** Readable, and long enough that nobody is tempted to keep it. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const users = await prisma.user.findMany({
    select: { id: true, username: true, displayName: true, role: true, totpEnabledAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (users.length === 0) {
    console.error('There are no accounts on this panel yet. Open the dashboard to create the first one.');
    process.exit(1);
  }

  let username = args.user;
  if (!username) {
    console.log('\nAccounts on this panel:\n');
    for (const user of users) {
      console.log(`  ${user.username.padEnd(20)} ${user.role.padEnd(8)} ${user.displayName}`);
    }
    console.log('');
    username = await ask('Which account? ');
  }

  const user = users.find((candidate) => candidate.username === username);
  if (!user) {
    console.error(`\nNo account called "${username}". Names are case-sensitive.`);
    process.exit(1);
  }

  let password: string;
  if (args.generate) {
    password = generatePassword();
  } else {
    password = await ask(`New password for ${user.username}: `, { hidden: true });
    const again = await ask('Again: ', { hidden: true });

    if (password !== again) {
      console.error('\nThose did not match. Nothing was changed.');
      process.exit(1);
    }

    // The panel's own rule, imported rather than restated — a password this
    // accepts and the dashboard rejects would be a maddening thing to hit
    // straight after resetting it.
    const checked = passwordSchema.safeParse(password);
    if (!checked.success) {
      console.error(`\n${checked.error.issues[0]?.message ?? 'That password is not acceptable.'}`);
      console.error('Nothing was changed.');
      process.exit(1);
    }
  }

  const passwordHash = await hash(password, ARGON2_OPTIONS);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // Clearing two-factor is deliberately separate. Someone who has lost
        // only their password should not have their second factor silently
        // removed as a side effect of fixing that.
        ...(args.clearTwoFactor
          ? { totpSecret: null, totpEnabledAt: null, recoveryCodeHashes: [] }
          : {}),
      },
    });

    // Every existing session dies, matching what changing a password in the
    // dashboard does. A reset is exactly the moment where a session someone
    // else is holding must stop working.
    await tx.session.deleteMany({ where: { userId: user.id } });
  });

  console.log(`\n✓ Password updated for ${user.username}, and all of their sessions signed out.`);

  if (args.generate) {
    console.log(`\n  New password: ${password}\n`);
    console.log('  Shown once. Change it under Account after signing in.');
  }

  if (user.totpEnabledAt && !args.clearTwoFactor) {
    console.log(
      '\n  Two-factor is still on for this account. If the authenticator is also gone,\n' +
        '  re-run with --clear-2fa, or use one of the recovery codes.',
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(`\nCould not reset the password: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
