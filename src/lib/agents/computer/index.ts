import crypto from 'crypto';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import SessionManager from '@/lib/session';
import { ComputerBlock } from '@/lib/types';
import { and, eq, gt } from 'drizzle-orm';
import { SwarmExecutor } from './swarmExecutor';
import { ComputerAgentInput } from './types';

class ComputerAgent {
  async executeAsync(session: SessionManager, input: ComputerAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.task,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    const computerBlockId = crypto.randomUUID();

    session.emitBlock({
      id: computerBlockId,
      type: 'computer',
      data: {
        subSteps: [],
      },
    } as ComputerBlock);

    try {
      const plan = input.config.swarmEnabled
        ? await SwarmExecutor.createSwarmPlan(input, session, computerBlockId)
        : {
            plan: 'Swarm mode is disabled, so a single general-purpose operator will execute the task.',
            agents: [{ role: 'operator' as const, task: input.task }],
          };

      if (!input.config.swarmEnabled) {
        const computerBlock = session.getBlock(computerBlockId);

        if (computerBlock && computerBlock.type === 'computer') {
          computerBlock.data.subSteps.push({
            id: crypto.randomUUID(),
            type: 'planning',
            plan: plan.plan,
            agents: plan.agents.map((agent) => ({
              role: agent.role,
              task: agent.task,
            })),
          });

          session.updateBlock(computerBlockId, [
            {
              op: 'replace',
              path: '/data/subSteps',
              value: computerBlock.data.subSteps,
            },
          ]);
        }
      }

      await SwarmExecutor.executeSwarm(plan, input, session, computerBlockId);

      session.emit('end', {});

      await db
        .update(messages)
        .set({
          status: 'completed',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Computer task failed';

      session.emit('error', { data: message });

      await db
        .update(messages)
        .set({
          status: 'error',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }
  }
}

export default ComputerAgent;
