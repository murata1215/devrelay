-- CreateTable
CREATE TABLE "BuildLog" (
    "id" TEXT NOT NULL,
    "buildNumber" INTEGER NOT NULL,
    "projectName" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "prompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuildLog_projectName_idx" ON "BuildLog"("projectName");

-- CreateIndex
CREATE INDEX "BuildLog_machineId_projectName_idx" ON "BuildLog"("machineId", "projectName");

-- CreateIndex
CREATE UNIQUE INDEX "BuildLog_projectName_buildNumber_key" ON "BuildLog"("projectName", "buildNumber");

-- AddForeignKey
ALTER TABLE "BuildLog" ADD CONSTRAINT "BuildLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildLog" ADD CONSTRAINT "BuildLog_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildLog" ADD CONSTRAINT "BuildLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildLog" ADD CONSTRAINT "BuildLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
