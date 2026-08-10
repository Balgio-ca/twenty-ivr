import nodemailer from 'nodemailer';
import { config } from './config.js';
import { log, warn } from './util/logger.js';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!config.email.smtpHost) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: config.email.smtpSecure,
      auth: config.email.smtpUser
        ? { user: config.email.smtpUser, pass: config.email.smtpPass }
        : undefined,
    });
  }
  return transporter;
}

export type MessageEmail = {
  nom: string;
  numeroRappel: string;
  sujet: string;
  message: string;
  afterHours: boolean;
};

/**
 * Envoie le message telephonique par courriel a l'equipe. Retourne false (sans
 * lever) si le SMTP n'est pas configure, pour que Gio degrade gracieusement.
 */
export async function sendMessageEmail(input: MessageEmail): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) {
    warn('email', 'SMTP non configure: courriel non envoye.');
    return false;
  }
  const from = config.email.from || config.email.smtpUser || 'gio@balgio.ca';
  const marqueur = input.afterHours ? ' (hors des heures)' : '';
  const subject = `Nouveau message telephonique${marqueur} - ${input.nom || 'appelant'}`;
  const text = [
    `Message pris par ${config.business.assistant} (standardiste IA).`,
    ``,
    `Nom: ${input.nom || 'non fourni'}`,
    `Numero de rappel: ${input.numeroRappel}`,
    `Objet: ${input.sujet || 'non precise'}`,
    ``,
    `Message:`,
    input.message,
  ].join('\n');

  await tx.sendMail({ from, to: config.email.to, subject, text });
  log('email', `Message envoye a ${config.email.to}`);
  return true;
}
