-- CreateTable
CREATE TABLE "ToolApproval" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "requestId" TEXT,
    "toolName" TEXT NOT NULL,
    "toolInput" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ToolApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolApproval_requestId_key" ON "ToolApproval"("requestId");

-- CreateIndex
CREATE INDEX "ToolApproval_projectId_createdAt_idx" ON "ToolApproval"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolApproval_sessionId_idx" ON "ToolApproval"("sessionId");

-- AddForeignKey
ALTER TABLE "ToolApproval" ADD CONSTRAINT "ToolApproval_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolApproval" ADD CONSTRAINT "ToolApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolApproval" ADD CONSTRAINT "ToolApproval_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
