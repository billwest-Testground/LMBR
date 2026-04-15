/**
 * Microsoft Graph / Outlook integration.
 *
 * Purpose:  Wraps MSAL auth + Graph client for LMBR.ai's Outlook ingest
 *           path. Customers forward RFQ emails (PDF/Excel attachments) to a
 *           monitored mailbox; the `/api/webhook/outlook` route uses this
 *           client to pull message bodies and attachments into the ingest
 *           pipeline, then hands off to the ingest-agent.
 * Inputs:   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
 *           MICROSOFT_TENANT_ID, MICROSOFT_REDIRECT_URI.
 * Outputs:  getOutlookClient(), fetchMessageAttachments().
 * Agent/API: Microsoft Graph API.
 * Imports:  @microsoft/microsoft-graph-client, @azure/msal-node.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication } from '@azure/msal-node';

export function getOutlookClient(): GraphClient {
  throw new Error('Not implemented');
}

export function getMsalApp(): ConfidentialClientApplication {
  throw new Error('Not implemented');
}

export async function fetchMessageAttachments(
  _messageId: string,
): Promise<Array<{ name: string; contentType: string; bytes: Uint8Array }>> {
  throw new Error('Not implemented');
}
