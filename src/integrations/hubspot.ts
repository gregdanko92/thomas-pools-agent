import { Client } from '@hubspot/api-client'
import type { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts/models/Filter'

// --- Types ---

export interface Contact {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  company: string | null
}

export interface Deal {
  id: string
  name: string | null
  stage: string | null
  amount: number | null
  closeDate: string | null
  ownerId: string | null
}

export interface SearchContactsOptions {
  query: string
  limit?: number
}

export interface ListDealsOptions {
  limit?: number
  after?: string
}

export interface ListDealsResult {
  deals: Deal[]
  nextCursor: string | null
}

// --- Env ---

function accessToken(): string {
  const token = process.env.HUBSPOT_ACCESS_TOKEN
  if (!token?.trim()) throw new Error('HUBSPOT_ACCESS_TOKEN is not set')
  return token
}

// --- Client ---

let _client: Client | null = null

function getClient(): Client {
  if (!_client) {
    _client = new Client({ accessToken: accessToken() })
  }
  return _client
}

// --- Mappers ---

function mapContact(raw: { id: string; properties: Record<string, string | null | undefined> }): Contact {
  return {
    id: raw.id,
    firstName: raw.properties['firstname'] ?? null,
    lastName: raw.properties['lastname'] ?? null,
    email: raw.properties['email'] ?? null,
    phone: raw.properties['phone'] ?? null,
    company: raw.properties['company'] ?? null,
  }
}

function mapDeal(raw: { id: string; properties: Record<string, string | null | undefined> }): Deal {
  const amount = raw.properties['amount']
  const parsed = amount != null && amount !== '' ? parseFloat(amount) : null
  return {
    id: raw.id,
    name: raw.properties['dealname'] ?? null,
    stage: raw.properties['dealstage'] ?? null,
    amount: parsed !== null && !isNaN(parsed) ? parsed : null,
    closeDate: raw.properties['closedate'] ?? null,
    ownerId: raw.properties['hubspot_owner_id'] ?? null,
  }
}

const CONTACT_PROPERTIES = ['firstname', 'lastname', 'email', 'phone', 'company']
const DEAL_PROPERTIES = ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id']

// HubSpot search API max results per page
const HUBSPOT_MAX_PAGE_SIZE = 100

// --- Exported helpers ---

export async function getContact(contactId: string): Promise<Contact> {
  const res = await getClient().crm.contacts.basicApi.getById(contactId, CONTACT_PROPERTIES)
  return mapContact(res)
}

export async function searchContacts(options: SearchContactsOptions): Promise<Contact[]> {
  const query = options.query.slice(0, 255)
  const res = await getClient().crm.contacts.searchApi.doSearch({
    query,
    limit: options.limit ?? 10,
    properties: CONTACT_PROPERTIES,
    filterGroups: [],
    sorts: [],
  })
  return res.results.map(mapContact)
}

export async function getDeal(dealId: string): Promise<Deal> {
  const res = await getClient().crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES)
  return mapDeal(res)
}

export async function listDeals(options: ListDealsOptions = {}): Promise<ListDealsResult> {
  const limit = Math.min(options.limit ?? HUBSPOT_MAX_PAGE_SIZE, HUBSPOT_MAX_PAGE_SIZE)
  const res = await getClient().crm.deals.basicApi.getPage(
    limit,
    options.after,
    DEAL_PROPERTIES,
  )
  return {
    deals: res.results.map(mapDeal),
    nextCursor: res.paging?.next?.after ?? null,
  }
}

export async function getContactByEmail(email: string): Promise<Contact | null> {
  const res = await getClient().crm.contacts.searchApi.doSearch({
    limit: 1,
    properties: CONTACT_PROPERTIES,
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'email',
            operator: 'EQ' as FilterOperatorEnum,
            value: email,
          },
        ],
      },
    ],
    sorts: [],
  })
  if (res.results.length === 0) return null
  return mapContact(res.results[0])
}
