import type { BlockedPerson } from '@/domain/circle-membership';
import { parseCircleShop, type CircleShop } from '@/domain/circle-shop';
import { withAccountTimeout } from '@/lib/account-timeout';
import { requireSupabase } from '@/lib/supabase';

const updateRequired = 'Circle controls need a server update. Nothing was changed. Please try again after the update.';
const uncertainResult = 'The result could not be confirmed. Refresh your circle before trying again.';
const changedAccount = 'Your account changed. Reopen Circle before trying again.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function checkId(value: string) {
  if (!uuid.test(value)) throw new Error('Refresh your circle before trying again.');
}

/** The expected owner also goes to SQL, guarding a session change during RPC. */
async function call(name: string, ownerId: string, args: Record<string, string>): Promise<unknown> {
  checkId(ownerId);
  for (const value of Object.values(args)) checkId(value);
  const client = requireSupabase();
  const verifyOwner = async () => {
    const { data, error } = await withAccountTimeout(client.auth.getSession(), changedAccount);
    if (error || data.session?.user.id !== ownerId) throw new Error(changedAccount);
  };
  await verifyOwner();
  // A timed-out mutation may have committed. Never claim that it failed or
  // replay it automatically; the UI refreshes authoritative membership.
  const { data, error } = await withAccountTimeout(client.rpc(name, { ...args, expected_user_id: ownerId }), uncertainResult);
  await verifyOwner();
  if (error?.code === 'PGRST202') throw new Error(updateRequired);
  if (error) throw new Error(error.message || uncertainResult);
  return data;
}

function membershipResult(value: unknown): { leftCircle: boolean; circleShop: CircleShop } {
  const shop = record(value) ? parseCircleShop(value.circleShop) : undefined;
  if (!record(value) || typeof value.leftCircle !== 'boolean' || !shop) throw new Error(uncertainResult);
  return { leftCircle: value.leftCircle, circleShop: shop };
}

export async function leaveSharedCircle(ownerId: string, groupId: string) {
  const result = membershipResult(await call('leave_shared_circle', ownerId, { expected_group_id: groupId }));
  if (result.leftCircle === (result.circleShop.id === groupId)) throw new Error(uncertainResult);
  return result;
}

export async function blockCirclePerson(ownerId: string, groupId: string, personId: string) {
  if (ownerId === personId) throw new Error('You cannot block yourself.');
  const data = await call('block_circle_person', ownerId, { expected_group_id: groupId, target_user_id: personId });
  if (!record(data) || data.blockedUserId !== personId) throw new Error(uncertainResult);
  const result = membershipResult(data);
  if (result.leftCircle === (result.circleShop.id === groupId)) throw new Error(uncertainResult);
  return result;
}

export async function unblockCirclePerson(ownerId: string, personId: string): Promise<void> {
  const data = await call('unblock_circle_person', ownerId, { target_user_id: personId });
  if (!record(data) || data.unblockedUserId !== personId) throw new Error(uncertainResult);
}

export async function getBlockedPeople(ownerId: string): Promise<BlockedPerson[]> {
  const data = await call('get_blocked_people', ownerId, {});
  if (!Array.isArray(data)) throw new Error('Your blocked list could not be loaded. Try again.');
  const seen = new Set<string>();
  return data.map(item => {
    if (!record(item) || typeof item.id !== 'string' || !uuid.test(item.id) || item.id === ownerId || seen.has(item.id)
      || typeof item.displayName !== 'string' || !item.displayName.trim()
      || typeof item.blockedAt !== 'string' || !Number.isFinite(Date.parse(item.blockedAt))) {
      throw new Error('Your blocked list could not be verified. Try again.');
    }
    seen.add(item.id);
    return { id: item.id, displayName: item.displayName, blockedAt: item.blockedAt };
  });
}
