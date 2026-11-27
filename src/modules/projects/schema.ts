import { z } from "zod";
import { Priority, ProjectStatus, TaskStatus, TaskParticipantRole } from "../../generated/prisma/enums.js";

export const id = z.uuid();
export const userId = z.string().min(1).max(128);
const title = z.string().trim().min(2).max(150);
const date = z.iso.date().transform((value) => new Date(value + "T00:00:00Z")).nullable();

const project = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(ProjectStatus).optional(),
  priority: z.enum(Priority).optional(),
  dueDate: date.optional(),
}).strict();

const task = z.object({
  title,
  description: z.string().trim().max(5000).optional(),
  priority: z.enum(Priority).optional(),
  status: z.enum(TaskStatus).optional(),
  startDate: date.optional(),
  dueDate: date.optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(12).transform((labels) => [...new Set(labels)]).optional(),
}).strict();

const page = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "due", "name"]).default("newest"),
  priority: z.enum(Priority).optional(),
}).strict();

export const projectCreate = project;
export const projectUpdate = project.partial().refine((value) => Object.keys(value).length > 0);
export const projectQuery = page.extend({ status: z.enum(ProjectStatus).optional() });
export const addMember = z.object({ userId }).strict();
export const taskCreate = task;
export const taskUpdate = task.partial().refine((value) => Object.keys(value).length > 0);
export const taskQuery = page.extend({ status: z.enum(TaskStatus).optional(), label: z.string().trim().max(30).optional() });
export const participant = z.object({ role: z.enum(TaskParticipantRole) }).strict();
export const subtaskCreate = z.object({ title }).strict();
export const subtaskUpdate = z.object({ title: title.optional(), completed: z.boolean().optional() }).strict()
  .refine((value) => Object.keys(value).length > 0);
