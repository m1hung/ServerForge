BEGIN;
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpLastCounter" INTEGER;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "publicAccess" BOOLEAN NOT NULL DEFAULT false;


COMMIT;
