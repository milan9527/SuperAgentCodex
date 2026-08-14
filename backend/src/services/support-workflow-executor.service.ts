/**
 * Support Workflow Executor Service
 * 
 * Executes the customer service workflow DAG synchronously (not via BullMQ).
 * Widget messages need immediate responses, so we run the workflow inline
 * rather than through the async queue-based execution engine.
 * 
 * Flow: Message → IntentClassifier → Condition → FaqLookup/Sentiment → Reply/Handoff
 */

import { nodeExecutorRegistry } from './node-executors/index.js';
import type { NodeExecutionContext } from './node-executors/types.js';
import type { CanvasNode } from '../types/workflow-execution.js';
import { prisma } from '../config/database.js';
import { supportRepository } from '../repositories/support.repository.js';
import { chatService } from './chat.service.js';
import { WIDGET_SYSTEM_USER_ID } from './widget-auth.service.js';

export interface WorkflowExecutionOutcome {
  /** AI-generated reply text (null if handoff) */
  reply: string | null;
  /** Whether the conversation was handed off to a human */
  handoff: boolean;
  /** Whether the conversation was auto-resolved */
  resolved: boolean;
  /** Intent classification result */
  intent: { intent: string; confidence: number; keywords: string[] } | null;
  /** Sentiment analysis result */
  sentiment: number | null;
  /** FAQ match result */
  faqMatch: { question: string; answer: string; score: number } | null;
  /** Decision reasoning trail */
  decisionTrail: string[];
}

export class SupportWorkflowExecutorService {
  /**
   * Execute the customer service workflow synchronously for a single message.
   * Returns the outcome (reply, handoff, or error).
   */
  async execute(
    organizationId: string,
    params: {
      message: string;
      sessionId: string;
      conversationId: string;
      businessScopeId?: string;
    },
  ): Promise<WorkflowExecutionOutcome> {
    const { message, sessionId, conversationId, businessScopeId } = params;
    const decisionTrail: string[] = [];
    let intent: WorkflowExecutionOutcome['intent'] = null;
    let sentiment: number | null = null;
    let faqMatch: WorkflowExecutionOutcome['faqMatch'] = null;

    // Build shared context
    const baseContext: Omit<NodeExecutionContext, 'nodeId' | 'nodeOutputs'> = {
      executionId: `cs-${conversationId}`,
      variables: new Map([
        ['message', message],
        ['sessionId', sessionId],
        ['conversationId', conversationId],
      ]),
      organizationId,
      userId: WIDGET_SYSTEM_USER_ID,
      businessScopeId,
    };

    // ========================================================================
    // Step 1: Intent Classification
    // ========================================================================
    const intentNode: CanvasNode = {
      id: 'intent',
      type: 'intentClassifier',
      position: { x: 0, y: 0 },
      data: { title: 'Intent Classifier', entityId: '', metadata: { confidenceThreshold: 0.6 } },
    };

    const intentResult = await nodeExecutorRegistry.execute({
      node: intentNode,
      context: {
        ...baseContext,
        nodeId: 'intent',
        nodeOutputs: new Map([['start', { message, text: message }]]),
      },
    });

    if (!intentResult.success) {
      decisionTrail.push(`Intent classification failed: ${intentResult.error}`);
      return { reply: null, handoff: true, resolved: false, intent: null, sentiment: null, faqMatch: null, decisionTrail };
    }

    const intentOutput = intentResult.output as Record<string, unknown>;
    const confidence = (intentOutput.confidence as number) ?? 0;
    intent = {
      intent: (intentOutput.intent as string) ?? 'general',
      confidence,
      keywords: (intentOutput.keywords as string[]) ?? [],
    };
    decisionTrail.push(`Intent: ${intent.intent} (confidence: ${confidence.toFixed(2)})`);

    // Update conversation with AI confidence
    await supportRepository.update(conversationId, organizationId, {
      ai_confidence: confidence,
      metadata: { intent: intent.intent, confidence, lastMessage: message } as any,
    }).catch(() => {});

    // ========================================================================
    // Step 2: Branch based on confidence
    // ========================================================================
    const CONFIDENCE_THRESHOLD = 0.6;

    if (confidence >= CONFIDENCE_THRESHOLD) {
      // HIGH CONFIDENCE PATH: FAQ Lookup → AI Reply
      decisionTrail.push(`High confidence (≥${CONFIDENCE_THRESHOLD}) → FAQ lookup`);

      // Step 2a: FAQ Lookup
      const faqNode: CanvasNode = {
        id: 'faq_lookup',
        type: 'faqLookup',
        position: { x: 0, y: 0 },
        data: { title: 'FAQ Lookup', entityId: '', metadata: { maxResults: 3, minScore: 0.2 } },
      };

      const faqResult = await nodeExecutorRegistry.execute({
        node: faqNode,
        context: {
          ...baseContext,
          nodeId: 'faq_lookup',
          nodeOutputs: new Map([
            ['start', { message, text: message }],
            ['intent', intentOutput],
          ]),
        },
      });

      if (faqResult.success) {
        const faqOutput = faqResult.output as Record<string, unknown>;
        const hasMatch = faqOutput.hasMatch as boolean;
        const bestMatch = faqOutput.bestMatch as Record<string, unknown> | null;

        if (hasMatch && bestMatch) {
          faqMatch = {
            question: bestMatch.question as string,
            answer: bestMatch.answer as string,
            score: bestMatch.score as number,
          };
          decisionTrail.push(`FAQ match found: "${faqMatch.question}" (score: ${faqMatch.score.toFixed(2)})`);

          // Use FAQ answer as the reply
          const replyText = faqMatch.answer;

          // Write reply to chat session
          await this.writeReply(organizationId, sessionId, replyText, conversationId);
          decisionTrail.push('AI replied with FAQ answer, conversation auto-resolved');

          return { reply: replyText, handoff: false, resolved: true, intent, sentiment, faqMatch, decisionTrail };
        } else {
          decisionTrail.push('No FAQ match found');
        }
      }

      // No FAQ match — fall through to AI generation via chatService
      decisionTrail.push('Falling through to AI agent for response generation');

      if (businessScopeId) {
        try {
          const aiResult = await chatService.processMessage({
            sessionId,
            businessScopeId,
            message,
            organizationId,
            userId: WIDGET_SYSTEM_USER_ID,
          });

          if (aiResult.text && aiResult.text !== '(No response)') {
            decisionTrail.push('AI agent generated response successfully');
            // Auto-resolve on high confidence AI reply
            await supportRepository.update(conversationId, organizationId, {
              status: 'resolved',
              resolved_at: new Date(),
            }).catch(() => {});
            return { reply: aiResult.text, handoff: false, resolved: true, intent, sentiment, faqMatch, decisionTrail };
          }
        } catch (err) {
          decisionTrail.push(`AI agent failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }

      // AI also failed — handoff
      decisionTrail.push('AI unable to respond → handoff to human');
      await supportRepository.update(conversationId, organizationId, { status: 'pending_agent' }).catch(() => {});
      return { reply: null, handoff: true, resolved: false, intent, sentiment, faqMatch, decisionTrail };

    } else {
      // LOW CONFIDENCE PATH: Sentiment Analysis → Handoff or Low-confidence AI reply
      decisionTrail.push(`Low confidence (<${CONFIDENCE_THRESHOLD}) → sentiment analysis`);

      // Step 2b: Sentiment Analysis (simple keyword-based)
      sentiment = this.analyzeSentiment(message);
      decisionTrail.push(`Sentiment score: ${sentiment.toFixed(2)}`);

      // Update conversation
      await supportRepository.update(conversationId, organizationId, {
        sentiment_score: sentiment,
      }).catch(() => {});

      const NEGATIVE_THRESHOLD = -0.3;

      if (sentiment < NEGATIVE_THRESHOLD) {
        // Negative sentiment → immediate handoff
        decisionTrail.push(`Negative sentiment (< ${NEGATIVE_THRESHOLD}) → handoff to human`);
        await supportRepository.update(conversationId, organizationId, { status: 'pending_agent' }).catch(() => {});

        // Send a holding message
        const holdingMessage = 'I understand your concern. Let me connect you with a support specialist who can help you better.';
        await this.writeReply(organizationId, sessionId, holdingMessage, conversationId, false);

        return { reply: holdingMessage, handoff: true, resolved: false, intent, sentiment, faqMatch, decisionTrail };
      }

      // Neutral/positive but low confidence → try AI agent
      decisionTrail.push('Neutral sentiment, attempting AI response with low confidence');

      if (businessScopeId) {
        try {
          const aiResult = await chatService.processMessage({
            sessionId,
            businessScopeId,
            message,
            organizationId,
            userId: WIDGET_SYSTEM_USER_ID,
          });

          if (aiResult.text && aiResult.text !== '(No response)') {
            decisionTrail.push('AI agent generated low-confidence response');
            // Don't auto-resolve on low confidence
            return { reply: aiResult.text, handoff: false, resolved: false, intent, sentiment, faqMatch, decisionTrail };
          }
        } catch (err) {
          decisionTrail.push(`AI agent failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        }
      }

      // Everything failed → handoff
      decisionTrail.push('All AI paths exhausted → handoff to human');
      await supportRepository.update(conversationId, organizationId, { status: 'pending_agent' }).catch(() => {});
      return { reply: null, handoff: true, resolved: false, intent, sentiment, faqMatch, decisionTrail };
    }
  }

  /**
   * Write an AI reply message to the chat session.
   */
  private async writeReply(
    organizationId: string,
    sessionId: string,
    content: string,
    conversationId: string,
    resolve = true,
  ): Promise<void> {
    await prisma.chat_messages.create({
      data: {
        organization_id: organizationId,
        session_id: sessionId,
        type: 'agent',
        content,
        metadata: { source: 'cs-workflow', automated: true },
      },
    });

    if (resolve) {
      await supportRepository.update(conversationId, organizationId, {
        status: 'resolved',
        resolved_at: new Date(),
        first_response_at: new Date(),
      }).catch(() => {});
    } else {
      // At least record first response time
      const conv = await supportRepository.findById(conversationId, organizationId);
      if (conv && !conv.first_response_at) {
        await supportRepository.update(conversationId, organizationId, {
          first_response_at: new Date(),
        }).catch(() => {});
      }
    }
  }

  /**
   * Simple keyword-based sentiment analysis.
   * Returns a score from -1 (very negative) to 1 (very positive).
   */
  private analyzeSentiment(message: string): number {
    const lower = message.toLowerCase();

    const negativeWords = [
      'angry', 'frustrated', 'terrible', 'awful', 'worst', 'hate', 'unacceptable',
      'disappointed', 'furious', 'ridiculous', 'horrible', 'disgusting', 'pathetic',
      'urgent', 'emergency', 'immediately', 'asap', 'broken', 'scam', 'fraud',
      '生气', '愤怒', '垃圾', '骗子', '投诉', '差评', '退款', '紧急', '立刻',
    ];

    const positiveWords = [
      'thank', 'thanks', 'great', 'good', 'excellent', 'wonderful', 'amazing',
      'helpful', 'appreciate', 'love', 'perfect', 'awesome', 'fantastic',
      '谢谢', '感谢', '很好', '满意', '不错', '优秀',
    ];

    let score = 0;
    for (const word of negativeWords) {
      if (lower.includes(word)) score -= 0.3;
    }
    for (const word of positiveWords) {
      if (lower.includes(word)) score += 0.2;
    }

    return Math.max(-1, Math.min(1, score));
  }
}

export const supportWorkflowExecutorService = new SupportWorkflowExecutorService();
