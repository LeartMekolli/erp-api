-- Hand-written (Settings people plan, Task 5): when staff cancelled a waiting invitation.
ALTER TABLE "invitation" ADD COLUMN "cancelled_at" TIMESTAMP(3);
