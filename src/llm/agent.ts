import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/** Client Claude partage par toutes les sessions d'appel. */
export const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
