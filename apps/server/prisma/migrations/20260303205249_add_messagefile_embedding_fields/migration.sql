-- AlterTable
ALTER TABLE "MessageFile" ADD COLUMN     "embeddingStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "textContent" TEXT;
