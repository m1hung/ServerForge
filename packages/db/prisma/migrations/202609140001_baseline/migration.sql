BEGIN;
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'user');

-- CreateEnum
CREATE TYPE "ServerState" AS ENUM ('creating', 'installing', 'install_failed', 'offline', 'starting', 'running', 'stopping', 'crashed', 'updating', 'restoring', 'suspended', 'deleting');

-- CreateEnum
CREATE TYPE "BackupState" AS ENUM ('pending', 'running', 'completed', 'failed', 'deleting');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'user',
    "avatarColor" TEXT NOT NULL DEFAULT '#f97316',
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "totpSecret" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "recoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['*']::TEXT[],
    "userId" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'docker',
    "agentUrl" TEXT,
    "agentToken" TEXT,
    "publicHost" TEXT NOT NULL DEFAULT 'localhost',
    "dataRoot" TEXT NOT NULL DEFAULT '/var/lib/serverforge/servers',
    "backupRoot" TEXT NOT NULL DEFAULT '/var/lib/serverforge/backups',
    "memoryMib" INTEGER NOT NULL DEFAULT 0,
    "diskMib" INTEGER NOT NULL DEFAULT 0,
    "cpuCores" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overheadPct" INTEGER NOT NULL DEFAULT 10,
    "portRangeStart" INTEGER NOT NULL DEFAULT 25500,
    "portRangeEnd" INTEGER NOT NULL DEFAULT 25999,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "maintenance" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '0.0.0.0',
    "port" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'game',
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "serverId" TEXT,

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" "ServerState" NOT NULL DEFAULT 'creating',
    "ownerId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "build" TEXT,
    "javaMajor" INTEGER,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "environment" JSONB NOT NULL DEFAULT '{}',
    "startupOverride" TEXT,
    "javaFlagsPreset" TEXT NOT NULL DEFAULT 'balanced',
    "customJavaFlags" TEXT,
    "memoryMib" INTEGER NOT NULL,
    "cpuCores" DOUBLE PRECISION NOT NULL,
    "diskMib" INTEGER NOT NULL,
    "swapMib" INTEGER,
    "ioWeight" INTEGER NOT NULL DEFAULT 500,
    "containerId" TEXT,
    "dataPath" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3),
    "lastStartAt" TIMESTAMP(3),
    "lastCrashAt" TIMESTAMP(3),
    "crashCount" INTEGER NOT NULL DEFAULT 0,
    "autoRestart" BOOLEAN NOT NULL DEFAULT true,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerUser" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRole" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "BackupState" NOT NULL DEFAULT 'pending',
    "filePath" TEXT,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "configuration" JSONB,
    "scheduleId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT,
    "triggerType" TEXT,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "onlyWhenOnline" BOOLEAN NOT NULL DEFAULT true,
    "actions" JSONB NOT NULL,
    "creatorId" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunOk" BOOLEAN,
    "lastRunError" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstalledMod" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "projectId" TEXT,
    "versionId" TEXT,
    "name" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'mod',
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "configuration" JSONB,
    "versionName" TEXT,
    "updateAvailable" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstalledMod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" BIGSERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memoryBytes" BIGINT NOT NULL,
    "diskBytes" BIGINT,
    "tps" DOUBLE PRECISION,
    "mspt" DOUBLE PRECISION,
    "networkRx" BIGINT NOT NULL DEFAULT 0,
    "networkTx" BIGINT NOT NULL DEFAULT 0,
    "playersOnline" INTEGER,

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstallLog" (
    "id" BIGSERIAL NOT NULL,
    "serverId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phase" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "InstallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "_ServerUserRoles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ServerUserRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_uid_key" ON "User"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_uid_key" ON "ApiKey"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_tokenHash_key" ON "ApiKey"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Node_uid_key" ON "Node"("uid");

-- CreateIndex
CREATE INDEX "Node_online_idx" ON "Node"("online");

-- CreateIndex
CREATE INDEX "Allocation_serverId_idx" ON "Allocation"("serverId");

-- CreateIndex
CREATE INDEX "Allocation_nodeId_serverId_idx" ON "Allocation"("nodeId", "serverId");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_nodeId_ip_port_key" ON "Allocation"("nodeId", "ip", "port");

-- CreateIndex
CREATE UNIQUE INDEX "Server_uid_key" ON "Server"("uid");

-- CreateIndex
CREATE INDEX "Server_ownerId_idx" ON "Server"("ownerId");

-- CreateIndex
CREATE INDEX "Server_nodeId_state_idx" ON "Server"("nodeId", "state");

-- CreateIndex
CREATE INDEX "Server_state_idx" ON "Server"("state");

-- CreateIndex
CREATE INDEX "ServerUser_userId_idx" ON "ServerUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerUser_serverId_userId_key" ON "ServerUser"("serverId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRole_uid_key" ON "AccessRole"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRole_name_key" ON "AccessRole"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Backup_uid_key" ON "Backup"("uid");

-- CreateIndex
CREATE INDEX "Backup_serverId_createdAt_idx" ON "Backup"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "Backup_scheduleId_idx" ON "Backup"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_uid_key" ON "Schedule"("uid");

-- CreateIndex
CREATE INDEX "Schedule_serverId_idx" ON "Schedule"("serverId");

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "Schedule_triggerType_enabled_idx" ON "Schedule"("triggerType", "enabled");

-- CreateIndex
CREATE INDEX "InstalledMod_serverId_idx" ON "InstalledMod"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledMod_serverId_fileName_key" ON "InstalledMod"("serverId", "fileName");

-- CreateIndex
CREATE INDEX "MetricSample_serverId_at_idx" ON "MetricSample"("serverId", "at");

-- CreateIndex
CREATE INDEX "Activity_serverId_at_idx" ON "Activity"("serverId", "at");

-- CreateIndex
CREATE INDEX "InstallLog_serverId_at_idx" ON "InstallLog"("serverId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "_ServerUserRoles_B_index" ON "_ServerUserRoles"("B");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerUser" ADD CONSTRAINT "ServerUser_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerUser" ADD CONSTRAINT "ServerUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backup" ADD CONSTRAINT "Backup_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledMod" ADD CONSTRAINT "InstalledMod_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstallLog" ADD CONSTRAINT "InstallLog_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ServerUserRoles" ADD CONSTRAINT "_ServerUserRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "AccessRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ServerUserRoles" ADD CONSTRAINT "_ServerUserRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "ServerUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
