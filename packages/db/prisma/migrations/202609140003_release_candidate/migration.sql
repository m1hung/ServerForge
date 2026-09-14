BEGIN;
-- CreateTable
CREATE TABLE "InstallationAttempt" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'preparing',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "error" TEXT,
    "stagingPath" TEXT NOT NULL,
    "sourcePackPath" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstallationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "grants" JSONB NOT NULL DEFAULT '[]',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstallationAttempt_uid_key" ON "InstallationAttempt"("uid");

-- CreateIndex
CREATE INDEX "InstallationAttempt_serverId_createdAt_idx" ON "InstallationAttempt"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "InstallationAttempt_state_idx" ON "InstallationAttempt"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_uid_key" ON "Invitation"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

-- AddForeignKey
ALTER TABLE "InstallationAttempt" ADD CONSTRAINT "InstallationAttempt_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
