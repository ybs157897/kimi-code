/**
 * `sessionTodoService` — session-scoped typed Todo list contract.
 * Mirrors `agent-core-v2/session/todo/sessionTodo.ts`.
 *
 * The session-shared todo list is materialized from the main agent's
 * `tools.update_store` wire records and mutated through `setTodos`.
 * Every agent in the session can read it.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const todoStatusSchema = z.enum(['pending', 'in_progress', 'done']);

export const todoItemSchema = z.object({
  title: z.string(),
  status: todoStatusSchema,
});

export const sessionTodoContract = {
  getTodos: { input: z.tuple([]), output: z.array(todoItemSchema) },
  setTodos: { input: z.tuple([z.array(todoItemSchema)]), output: noResult },
  clear: { input: z.tuple([]), output: noResult },
} satisfies ServiceContract;
