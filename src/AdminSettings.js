import React, { useState, useEffect, useRef } from 'react';
import ProgramStatusBadge, { fetchProgramStatus } from './ProgramStatusBadge';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabaseClient';
import { Plus, Users, X, Edit2, Save, Trash2, UserPlus, ChevronRight, Search, CheckCircle, XCircle, Calendar, Clock, ClipboardList, Mail, AlertTriangle, Key } from 'lucide-react';
import { formatUserError } from './errorMessage';
import { useModalTracking, trackAction } from './usage';
import { COACH_SKILL_OPTIONS, SC_SKILL } from './skillOptions';
import { allowanceForName, stripFrequencySuffix, LIFTING_WEEKLY_CAP } from './bookingCaps';
import BulkTagFacilityEventTeams from './BulkTagFacilityEventTeams';
import SoftwareDownloads from './SoftwareDownloads';
import { notifyTasksAssigned, fetchLastNotified, formatNotifiedAt } from './coachTaskNotify';

async function deleteAuthUser(userId) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(
    `${supabaseUrl}/functions/v1/delete-user`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ user_id: userId }),
    }
  );
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Failed to delete auth user');
  return result;
}

async function updateAuthUserEmail(userId, newEmail) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(
    `${supabaseUrl}/functions/v1/update-user-email`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ user_id: userId, new_email: newEmail }),
    }
  );
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Failed to update auth email');
  return result;
}

// #312: manual password reset, admin + coach — see reset-user-password's own
// comment for the 2026-08-12 decision that widened this from admin-only.
async function resetUserPassword(userId, newPassword) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(
    `${supabaseUrl}/functions/v1/reset-user-password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': supabaseAnonKey,
      },
      body: JSON.stringify({ user_id: userId, new_password: newPassword }),
    }
  );
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Failed to reset password');
  return result;
}

export default function AdminSettings(props) {
  if (props.userRole !== 'admin' && props.userRole !== 'coach') {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-gray-900 mb-2">Access denied</h2>
        <p className="text-sm text-gray-600">Settings are available to coaches and admins only.</p>
      </div>
    );
  }
  return <AdminSettingsInner {...props} />;
}

function AdminSettingsInner({ userId, userRole, onNavigateToProfile }) {
  const [activeTab, setActiveTab] = useState('users');
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showAssignRole, setShowAssignRole] = useState(false);
  const [showCreateProspect, setShowCreateProspect] = useState(false);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [waiverSignatures, setWaiverSignatures] = useState([]);
  const [contractSignatures, setContractSignatures] = useState([]);
  const [medicalHistories, setMedicalHistories] = useState([]);

  const coaches = users.filter(u => u.role === 'coach');
  const players = users.filter(u => u.role === 'player');

  const fetchProspects = async () => {
    const { data, error } = await supabase
      .from('prospects')
      .select('*')
      .order('full_name');
    if (error) console.error('Error fetching prospects:', error);
    else setProspects(data || []);
  };

  const fetchWaiverSignatures = async () => {
    const { data, error } = await supabase
      .from('waiver_signatures')
      .select('*');
    if (error) console.error('Error fetching waiver signatures:', error);
    else setWaiverSignatures(data || []);
  };

  const fetchContractSignatures = async () => {
    const { data, error } = await supabase
      .from('player_contracts')
      .select('user_id, signed_at');
    if (error) console.error('Error fetching contracts:', error);
    else setContractSignatures(data || []);
  };

  const fetchMedicalHistories = async () => {
    const { data, error } = await supabase
      .from('medical_history')
      .select('user_id, signed_at');
    if (error) console.error('Error fetching medical histories:', error);
    else setMedicalHistories(data || []);
  };

  useEffect(() => {
    fetchTeams();
    fetchUsers();
    fetchProspects();
    fetchWaiverSignatures();
    fetchContractSignatures();
    fetchMedicalHistories();
  }, []);

  const fetchTeams = async () => {
    const { data, error } = await supabase
      .from('teams')
      .select('*')
      .order('name');

    if (error) {
      console.error('Error fetching teams:', error);
    } else {
      setTeams(data);
    }
    setLoading(false);
  };

  const fetchUsers = async () => {
    const PAGE = 1000;
    const all = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('users')
        .select(`
          *,
          player_profiles!player_profiles_user_id_fkey(*),
          team_members(
            team_id,
            teams(name, team_type)
          )
        `)
        .order('full_name')
        .range(from, from + PAGE - 1);

      if (error) {
        console.error('Error fetching users:', error);
        return;
      }
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    setUsers(all);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">Admin Settings</h2>
          <p className="text-gray-600 mt-1">Manage users, teams, and organization settings</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg shadow">
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8 px-6 overflow-x-auto">
            <button
              onClick={() => setActiveTab('users')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'users'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Users ({users.length})
            </button>
            <button
              onClick={() => setActiveTab('teams')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'teams'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Teams ({teams.filter(t => (t.team_type || 'team') !== 'training').length})
            </button>
            <button
              onClick={() => setActiveTab('coaches')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'coaches'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Coaches ({coaches.length})
            </button>
            <button
              onClick={() => setActiveTab('coach-tasks')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition whitespace-nowrap ${
                activeTab === 'coach-tasks'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Coach Tasks
            </button>
            <button
              onClick={() => setActiveTab('prospects')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'prospects'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Prospects
            </button>
            <button
              onClick={() => setActiveTab('codes')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'codes'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Codes
            </button>
            <button
              onClick={() => setActiveTab('inventory')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'inventory'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Inventory
            </button>
            <button
              onClick={() => setActiveTab('documents')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'documents'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Documents
            </button>
            <button
              onClick={() => setActiveTab('trackman')}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition ${
                activeTab === 'trackman'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Trackman
            </button>
            {/* #308: admin-only, unlike every other tab on this page (which is
                shared with coaches) — bulk-assigning teams to facility events
                is a staffing/ops decision, not day-to-day coach work. */}
            {userRole === 'admin' && (
              <button
                onClick={() => setActiveTab('facility-teams')}
                className={`py-4 px-1 border-b-2 font-medium text-sm transition whitespace-nowrap ${
                  activeTab === 'facility-teams'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Facility Teams
              </button>
            )}
            {/* Admin-only: installers for the desktop tools staff run alongside
                the portal (BullpenSync first). Coaches get a tool from an
                admin, not from here. */}
            {userRole === 'admin' && (
              <button
                onClick={() => setActiveTab('downloads')}
                className={`py-4 px-1 border-b-2 font-medium text-sm transition whitespace-nowrap ${
                  activeTab === 'downloads'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Downloads
              </button>
            )}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'users' && (
            <UsersTab
              users={users}
              teams={teams}
              showCreateUser={showCreateUser}
              setShowCreateUser={setShowCreateUser}
              refreshUsers={fetchUsers}
              userId={userId}
              userRole={userRole}
              onNavigateToProfile={onNavigateToProfile}
            />
          )}
          {activeTab === 'teams' && (
            <TeamsTab
              teams={teams}
              users={users}
              showCreateTeam={showCreateTeam}
              setShowCreateTeam={setShowCreateTeam}
              refreshTeams={fetchTeams}
              refreshUsers={fetchUsers}
            />
          )}
          {activeTab === 'coaches' && (
            <CoachesTab
              coaches={coaches}
              users={users}
              showAssignRole={showAssignRole}
              setShowAssignRole={setShowAssignRole}
              refreshUsers={fetchUsers}
            />
          )}
          {activeTab === 'coach-tasks' && (
            <CoachTasksTab coaches={coaches} userId={userId} />
          )}
          {activeTab === 'prospects' && (
            <ProspectsTab
              prospects={prospects}
              teams={teams}
              showCreateProspect={showCreateProspect}
              setShowCreateProspect={setShowCreateProspect}
              refreshProspects={fetchProspects}
            />
          )}
          {activeTab === 'codes' && (
            <CodesTab players={players} />
          )}
          {activeTab === 'inventory' && (
            <InventoryTab />
          )}
          {activeTab === 'documents' && (
            <DocumentsTab players={players} waiverSignatures={waiverSignatures} contractSignatures={contractSignatures} medicalHistories={medicalHistories} />
          )}
          {activeTab === 'trackman' && (
            <TrackmanAdminTab users={users} userId={userId} />
          )}
          {activeTab === 'facility-teams' && userRole === 'admin' && (
            <BulkTagFacilityEventTeams />
          )}
          {activeTab === 'downloads' && userRole === 'admin' && (
            <SoftwareDownloads />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// TRACKMAN ADMIN TAB (#44) — sync + name→athlete mapping
// ============================================

function TrackmanAdminTab({ users, userId }) {
  const [directory, setDirectory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [sessionCount, setSessionCount] = useState(null);

  const athletes = (users || []).slice().sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  const fetchDirectory = async () => {
    setLoading(true);
    const [{ data: dir }, { count }] = await Promise.all([
      supabase.rpc('trackman_name_directory'),
      supabase.from('trackman_sessions').select('id', { count: 'exact', head: true }),
    ]);
    setDirectory(dir || []);
    setSessionCount(count ?? null);
    setLoading(false);
  };
  useEffect(() => { fetchDirectory(); }, []);

  // Assign (or clear) a Trackman name -> athlete, and backfill existing pitches.
  const assignName = async (name, uid) => {
    setSaving(name);
    try {
      if (uid) {
        await supabase.from('trackman_player_map').upsert(
          { trackman_name: name, user_id: uid, created_by: userId, updated_at: new Date().toISOString() },
          { onConflict: 'trackman_name' }
        );
        await supabase.from('trackman_pitches').update({ pitcher_user_id: uid }).eq('pitcher_name', name);
        await supabase.from('trackman_pitches').update({ batter_user_id: uid }).eq('batter_name', name);
      } else {
        await supabase.from('trackman_player_map').delete().eq('trackman_name', name);
        await supabase.from('trackman_pitches').update({ pitcher_user_id: null }).eq('pitcher_name', name);
        await supabase.from('trackman_pitches').update({ batter_user_id: null }).eq('batter_name', name);
      }
      await fetchDirectory();
    } catch (e) {
      alert('Error: ' + formatUserError(e));
    } finally { setSaving(null); }
  };

  const runSync = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/trackman-sync', { method: 'POST', headers: { Authorization: `Bearer ${session?.access_token || ''}` } });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch { /* non-JSON (e.g. 404 on local dev) */ }
      if (!res.ok || !data) {
        setSyncMsg({ ok: false, text: data?.error || `Sync unavailable (HTTP ${res.status}). It runs on the deployed site, not local dev.` });
      } else {
        setSyncMsg({ ok: true, text: `Imported ${data.files_imported} file(s), ${data.pitches_upserted} pitch rows.${data.remaining ? ` ${data.remaining} file(s) remain for the next run.` : ''}` });
        await fetchDirectory();
      }
    } catch (e) {
      setSyncMsg({ ok: false, text: String(e.message || e) });
    } finally { setSyncing(false); }
  };

  const unmapped = directory.filter(d => !d.mapped_user_id);
  const mapped = directory.filter(d => d.mapped_user_id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Trackman</h3>
          <p className="text-sm text-gray-500">
            {sessionCount != null ? `${sessionCount} session file(s) imported. ` : ''}
            Map each Trackman player name to an athlete so their stats appear on their profile.
          </p>
        </div>
        <button onClick={runSync} disabled={syncing} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {syncMsg && (
        <div className={`text-sm rounded-lg p-3 flex items-start gap-2 ${syncMsg.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
          {syncMsg.ok ? <CheckCircle size={16} className="mt-0.5 flex-shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />}
          <span>{syncMsg.text}</span>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : directory.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No Trackman data yet. Run a sync to import session files.</p>
      ) : (
        <>
          <TrackmanNameSection title={`Needs mapping (${unmapped.length})`} rows={unmapped} athletes={athletes} onAssign={assignName} saving={saving} highlight />
          <TrackmanNameSection title={`Mapped (${mapped.length})`} rows={mapped} athletes={athletes} onAssign={assignName} saving={saving} />
        </>
      )}
    </div>
  );
}

function TrackmanNameSection({ title, rows, athletes, onAssign, saving, highlight }) {
  if (!rows.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{title}</h4>
      <div className="space-y-1.5">
        {rows.map(r => (
          <div key={r.trackman_name} className={`flex items-center justify-between gap-3 p-2.5 rounded-lg border ${highlight ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'}`}>
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{r.trackman_name}</div>
              <div className="text-xs text-gray-400">{r.appearances} pitch{Number(r.appearances) === 1 ? '' : 'es'}</div>
            </div>
            <select
              value={r.mapped_user_id || ''}
              disabled={saving === r.trackman_name}
              onChange={(e) => onAssign(r.trackman_name, e.target.value || null)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[220px] disabled:opacity-50"
            >
              <option value="">— Unassigned —</option>
              {athletes.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================
// COACHES TAB
// ============================================

function CoachesTab({ coaches, users, showAssignRole, setShowAssignRole, refreshUsers }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  const getCoachStatus = (c) => c.coach_status || 'Active';

  const statusCounts = { Active: 0, Inactive: 0, Archived: 0 };
  coaches.forEach(c => {
    const s = getCoachStatus(c);
    if (s === 'Inactive') statusCounts.Inactive++;
    else if (s === 'Archived') statusCounts.Archived++;
    else statusCounts.Active++;
  });

  const filteredCoaches = coaches.filter(c => {
    const q = searchQuery.toLowerCase();
    if (!(c.full_name || '').toLowerCase().includes(q) && !(c.email || '').toLowerCase().includes(q)) return false;
    if (filterStatus !== 'all') {
      const status = getCoachStatus(c);
      if (filterStatus === 'Active' && status !== 'Active') return false;
      if (filterStatus === 'Inactive' && status !== 'Inactive') return false;
      if (filterStatus === 'Archived' && status !== 'Archived') return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">All Coaches</h3>
        <button
          onClick={() => setShowAssignRole(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
        >
          <Plus size={18} />
          <span>Assign Coach Role</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search coaches by name or email..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Statuses</option>
          <option value="Active">Active ({statusCounts.Active})</option>
          <option value="Inactive">Inactive ({statusCounts.Inactive})</option>
          <option value="Archived">Archived ({statusCounts.Archived})</option>
        </select>
      </div>

      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Active {statusCounts.Active}</span>
        <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">Inactive {statusCounts.Inactive}</span>
        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Archived {statusCounts.Archived}</span>
        <span className="ml-auto text-gray-400">{filteredCoaches.length} shown</span>
      </div>

      {filteredCoaches.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Users size={48} className="mx-auto mb-4 text-gray-300" />
          <p>{searchQuery || filterStatus !== 'all' ? 'No coaches match your filters.' : 'No coaches yet. Assign the coach role to a user to get started.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredCoaches.map(coach => (
            <CoachCard key={coach.id} coach={coach} refreshUsers={refreshUsers} />
          ))}
        </div>
      )}

      <WeeklyBookingCapsPanel coaches={coaches} />

      {showAssignRole && (
        <AssignRoleModal
          users={users}
          onClose={() => setShowAssignRole(false)}
          onSuccess={() => {
            setShowAssignRole(false);
            refreshUsers();
          }}
        />
      )}
    </div>
  );
}

// #276 — read-only visibility on the weekly booking caps. Lists every active
// package/lesson product and the cap the name-parsing rule derives from it, so
// the owner can eyeball that the parsing is right before trusting the warnings.
// Nothing here is editable and nothing is written; overrides are out of scope.
// Lives next to the coach list on purpose: the other half of the rule is which
// coaches carry the "Strength & Conditioning" tag above.
function WeeklyBookingCapsPanel({ coaches }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || rows) return;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('store_products')
        .select('id, name, kind, active')
        .eq('active', true)
        .in('kind', ['package', 'lesson'])
        .order('name');
      if (error) {
        console.error('Error loading products for booking caps:', error);
        setRows([]);
        setLoading(false);
        return;
      }
      // Square exported the same package once per billing frequency. Group on
      // the family name so this reads as one row per real package.
      const byFamily = {};
      (data || []).forEach(p => {
        const family = stripFrequencySuffix(p.name);
        const key = family.toLowerCase();
        // #306: table-first (Cordell's six named programmes), name-parse second.
        if (!byFamily[key]) byFamily[key] = { family, allowance: allowanceForName(p.name), variants: 0 };
        byFamily[key].variants++;
      });
      setRows(Object.values(byFamily).sort((a, b) => a.family.localeCompare(b.family)));
      setLoading(false);
    })();
  }, [open, rows]);

  const scCoaches = (coaches || []).filter(c => (c.skills || []).includes(SC_SKILL));

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <div className="font-semibold text-gray-900 text-sm">Weekly booking caps by package</div>
          <div className="text-xs text-gray-500">How many S&amp;C and skills sessions a week each package allows (read-only)</div>
        </div>
        <ChevronRight size={18} className={`text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-gray-200 p-4 space-y-3">
          <div className="text-xs text-gray-600 space-y-1">
            <p>Six programmes have allowances Cordell set by hand (e.g. NBP College Training: 4 S&amp;C + 1 skills a week; Trevor May Pitching Academy: 1 a week, with Trevor May only). For everything else, a package named <span className="font-medium">one time a week</span> allows 1 skills session a week, one named <span className="font-medium">2–4 times a week</span> allows 2, and every package allows up to {LIFTING_WEEKLY_CAP} S&amp;C sessions a week.</p>
            <p>A session counts as <span className="font-medium">S&amp;C</span> when the coach set its <span className="font-medium">Session type</span> to Strength &amp; Conditioning when creating it; when that is not set, it counts as S&amp;C if the coach carries the “{SC_SKILL}” skill tag. Packages showing “—” have no stated allowance: no cap is applied and no warning is shown.</p>
            <p className="text-gray-500">Going over the cap only warns the athlete or coach — it never blocks the booking.</p>
          </div>

          <div className={`rounded-lg px-3 py-2 text-xs ${scCoaches.length === 0 ? 'bg-amber-50 border border-amber-200 text-amber-800' : 'bg-gray-50 border border-gray-200 text-gray-700'}`}>
            {scCoaches.length === 0
              ? <>No coach is tagged “{SC_SKILL}” yet, so every session counts as non-lifting. Tag your S&amp;C coaches on their cards above.</>
              : <>Tagged “{SC_SKILL}”: <span className="font-medium">{scCoaches.map(c => c.full_name).join(', ')}</span></>}
          </div>

          {loading && <div className="text-xs text-gray-400">Loading packages…</div>}
          {rows && rows.length === 0 && !loading && <div className="text-xs text-gray-400">No active packages found.</div>}
          {rows && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-3 font-medium">Package</th>
                    <th className="py-2 pr-3 font-medium whitespace-nowrap">Skills / week</th>
                    <th className="py-2 font-medium whitespace-nowrap">S&amp;C / week</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.family} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 pr-3 text-gray-900">
                        {r.family}
                        {r.variants > 1 && <span className="ml-2 text-[11px] text-gray-400">{r.variants} Square listings</span>}
                        {r.allowance?.coachOnly && <span className="ml-2 text-[11px] text-amber-700">with {r.allowance.coachOnly.map(n => n.replace(/\b\w/g, c => c.toUpperCase())).join(' or ')} only</span>}
                      </td>
                      {r.allowance == null ? (
                        <>
                          <td className="py-2 pr-3"><span className="text-gray-400">—</span></td>
                          <td className="py-2"><span className="text-gray-400">—</span></td>
                        </>
                      ) : r.allowance.any != null ? (
                        <td className="py-2" colSpan={2}><span className="font-medium text-gray-900">{r.allowance.any}</span> <span className="text-gray-500">a week, either kind</span></td>
                      ) : (
                        <>
                          <td className="py-2 pr-3"><span className="font-medium text-gray-900">{r.allowance.skills ?? '—'}</span></td>
                          <td className="py-2 text-gray-900">{r.allowance.sc ?? '—'}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CoachCard({ coach, refreshUsers }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(coach.title || '');
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const handleRemoveCoach = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('users')
      .update({ role: 'player', title: null })
      .eq('id', coach.id);

    if (error) {
      console.error('Error removing coach:', error);
      alert('Error removing coach: ' + formatUserError(error));
    } else {
      refreshUsers();
    }
    setSaving(false);
    setConfirmRemove(false);
  };

  const handleSaveTitle = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('users')
      .update({ title: title || null })
      .eq('id', coach.id);

    if (error) {
      console.error('Error updating title:', error);
      alert('Error updating title: ' + formatUserError(error));
    } else {
      await refreshUsers();
      setEditingTitle(false);
    }
    setSaving(false);
  };

  const handleToggleSkill = async (skill) => {
    const current = coach.skills || [];
    const next = current.includes(skill)
      ? current.filter(s => s !== skill)
      : [...current, skill];
    setSaving(true);
    const { error } = await supabase
      .from('users')
      .update({ skills: next })
      .eq('id', coach.id);
    if (error) {
      console.error('Error updating skills:', error);
      alert('Error updating skills: ' + formatUserError(error));
    } else {
      await refreshUsers();
    }
    setSaving(false);
  };

  return (
    <div className="bg-gray-50 rounded-lg p-4 hover:bg-gray-100 transition">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-semibold text-lg">
            {coach.full_name.charAt(0)}
          </div>
          <div>
            <h4 className="font-semibold text-gray-900">{coach.full_name}</h4>
            <p className="text-sm text-gray-600">{coach.email}</p>
            {/* Title editing */}
            <div className="flex items-center mt-1">
              {editingTitle ? (
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g., Head Coach, Pitching Coach"
                    className="text-sm px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveTitle();
                      if (e.key === 'Escape') { setEditingTitle(false); setTitle(coach.title || ''); }
                    }}
                  />
                  <button
                    onClick={handleSaveTitle}
                    disabled={saving}
                    className="text-green-600 hover:text-green-700"
                  >
                    <Save size={16} />
                  </button>
                  <button
                    onClick={() => { setEditingTitle(false); setTitle(coach.title || ''); }}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-500">
                    {coach.title || 'No title set'}
                  </span>
                  <button
                    onClick={() => setEditingTitle(true)}
                    className="text-gray-400 hover:text-blue-600"
                  >
                    <Edit2 size={14} />
                  </button>
                </div>
              )}
            </div>
            {/* Skills the coach can cover for booking (#245) */}
            <div className="mt-2">
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1">Skills covered</p>
              <div className="flex flex-wrap gap-1.5">
                {COACH_SKILL_OPTIONS.map(skill => {
                  const active = (coach.skills || []).includes(skill);
                  return (
                    <button
                      key={skill}
                      onClick={() => handleToggleSkill(skill)}
                      disabled={saving}
                      className={`text-xs px-2 py-0.5 rounded-full border transition disabled:opacity-50 ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`}
                    >
                      {skill}
                    </button>
                  );
                })}
              </div>
            </div>
            {coach.team_members && coach.team_members.length > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                Teams: {coach.team_members.map(tm => tm.teams?.name).filter(Boolean).join(', ')}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
            coach
          </span>
          {confirmRemove ? (
            <div className="flex items-center space-x-2">
              <span className="text-xs text-red-600">Demote to player?</span>
              <button
                onClick={handleRemoveCoach}
                disabled={saving}
                className="text-red-600 hover:text-red-700 text-xs font-medium"
              >
                {saving ? '...' : 'Yes'}
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="text-gray-400 hover:text-gray-600 text-xs font-medium"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="text-gray-400 hover:text-red-600 transition"
              title="Remove coach role"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AssignRoleModal({ users, onClose, onSuccess }) {
  const [selectedUserId, setSelectedUserId] = useState('');
  const [targetRole, setTargetRole] = useState('coach');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedUserId) return;
    setLoading(true);
    setError('');

    try {
      const updateData = { role: targetRole };
      if (targetRole === 'coach') {
        updateData.title = title || null;
      } else {
        updateData.title = null;
      }

      const { error: updateError } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', selectedUserId);

      if (updateError) throw updateError;

      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const selectedUser = users.find(u => u.id === selectedUserId);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350: capped with a scrolling body so Cancel and Assign Role stay on
          screen when the window is short. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Assign Role</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select User *
            </label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Choose a user...</option>
              {users.map(user => (
                <option key={user.id} value={user.id}>
                  {user.full_name} ({user.email}) - {user.role}
                </option>
              ))}
            </select>
          </div>

          {selectedUser && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm">
              <p className="text-gray-600">
                Current role: <span className="font-medium text-gray-900">{selectedUser.role}</span>
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              New Role *
            </label>
            <div className="space-y-2">
              {['player', 'coach', 'admin'].map(role => (
                <label key={role} className="flex items-center space-x-3 cursor-pointer">
                  <input
                    type="radio"
                    name="targetRole"
                    value={role}
                    checked={targetRole === role}
                    onChange={(e) => setTargetRole(e.target.value)}
                    className="text-blue-600"
                  />
                  <span className="capitalize text-gray-900">{role}</span>
                </label>
              ))}
            </div>
          </div>

          {targetRole === 'coach' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Coach Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Head Coach, Pitching Coach, Hitting Instructor"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

        </div>
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !selectedUserId}
              className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Assign Role'}
            </button>
        </div>
        </form>
      </div>
    </div>
  );
}

// ============================================
// USERS TAB
// ============================================

function UsersTab({ users, teams, showCreateUser, setShowCreateUser, refreshUsers, userId, userRole, onNavigateToProfile }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  // Default to Active so Settings opens showing current athletes/staff only.
  // Inactive, Archived and "All Statuses" are still one click away below.
  const [filterStatus, setFilterStatus] = useState('Active');
  const [sortBy, setSortBy] = useState('name');
  const [showDuplicates, setShowDuplicates] = useState(false);
  // #436: programmed check marks for users in a training group; null until loaded.
  const [programStatus, setProgramStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const ids = (users || []).filter(u => (u.team_members || []).some(tm => tm.teams?.team_type === 'training')).map(u => u.id);
    fetchProgramStatus(ids).then(map => { if (!cancelled) setProgramStatus(map); });
    return () => { cancelled = true; };
  }, [users]);

  const getUserStatus = (u) => {
    if (u.role === 'player') {
      const pp = Array.isArray(u.player_profiles) ? u.player_profiles[0] : u.player_profiles;
      return pp?.status || 'Active';
    }
    if (u.role === 'coach') return u.coach_status || 'Active';
    return 'Active';
  };

  const filteredUsers = users.filter(u => {
    const q = searchQuery.toLowerCase();
    if (!(u.full_name || '').toLowerCase().includes(q) && !(u.email || '').toLowerCase().includes(q)) return false;
    if (filterRole !== 'all' && u.role !== filterRole) return false;
    if (filterStatus !== 'all') {
      const status = getUserStatus(u);
      if (filterStatus === 'Active' && status !== 'Active') return false;
      if (filterStatus === 'Inactive' && status !== 'Inactive') return false;
      if (filterStatus === 'Archived' && status !== 'Archived') return false;
    }
    return true;
  });

  // Active first, then Inactive, then Archived. Only has a visible effect when
  // the status filter is "All Statuses" — otherwise the list is already one
  // status. The chosen Sort option still orders users within each group.
  const statusRank = (u) => {
    const s = getUserStatus(u);
    if (s === 'Inactive') return 1;
    if (s === 'Archived') return 2;
    return 0;
  };

  const sortedUsers = [...filteredUsers].sort((a, b) => {
    const rank = statusRank(a) - statusRank(b);
    if (rank !== 0) return rank;
    if (sortBy === 'name') return 0;
    const da = a.date_of_birth ? new Date(a.date_of_birth) : null;
    const db = b.date_of_birth ? new Date(b.date_of_birth) : null;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return sortBy === 'age_asc' ? da - db : db - da;
  });

  const statusCounts = { Active: 0, Inactive: 0, Archived: 0 };
  const roleFiltered = users.filter(u => filterRole === 'all' || u.role === filterRole);
  roleFiltered.forEach(u => {
    const s = getUserStatus(u);
    if (s === 'Inactive') statusCounts.Inactive++;
    else if (s === 'Archived') statusCounts.Archived++;
    else statusCounts.Active++;
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">All Users</h3>
        <button
          onClick={() => setShowCreateUser(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
        >
          <Plus size={18} />
          <span>Create User</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search users by name or email..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Roles</option>
          <option value="admin">Admin</option>
          <option value="coach">Coach</option>
          <option value="player">Player</option>
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All Statuses</option>
          <option value="Active">Active ({statusCounts.Active})</option>
          <option value="Inactive">Inactive ({statusCounts.Inactive})</option>
          <option value="Archived">Archived ({statusCounts.Archived})</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="name">Sort: Name A–Z</option>
          <option value="age_asc">Sort: Oldest First</option>
          <option value="age_desc">Sort: Youngest First</option>
        </select>
        <button
          onClick={() => setShowDuplicates(d => !d)}
          className={`border rounded-lg px-3 py-2 text-sm font-medium transition ${showDuplicates ? 'bg-orange-100 text-orange-700 border-orange-300' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
        >
          Find Duplicates
        </button>
      </div>

      {showDuplicates ? (
        <DuplicatesTab users={users} refreshUsers={refreshUsers} onNavigateToProfile={onNavigateToProfile} />
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Active {statusCounts.Active}</span>
            <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">Inactive {statusCounts.Inactive}</span>
            <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">Archived {statusCounts.Archived}</span>
            <span className="ml-auto text-gray-400">{filteredUsers.length} shown</span>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {sortedUsers.map(user => (
              <UserCard key={user.id} user={user} teams={teams} refreshUsers={refreshUsers} userId={userId} userRole={userRole} onNavigateToProfile={onNavigateToProfile} programStatus={programStatus ? programStatus[user.id] : undefined} />
            ))}
          </div>
        </>
      )}

      {showCreateUser && (
        <CreateUserModal
          teams={teams}
          callerRole={userRole}
          onClose={() => setShowCreateUser(false)}
          onSuccess={() => {
            setShowCreateUser(false);
            refreshUsers();
          }}
        />
      )}
    </div>
  );
}

function UserCard({ user, teams, refreshUsers, userId, userRole, onNavigateToProfile, programStatus }) {
  const [showEdit, setShowEdit] = useState(false);

  const getRoleBadgeColor = (role) => {
    switch(role) {
      case 'admin': return 'bg-purple-100 text-purple-700';
      case 'coach': return 'bg-blue-100 text-blue-700';
      case 'player': return 'bg-green-100 text-green-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const getStatusBadgeColor = (status) => {
    switch (status) {
      case 'Inactive': return 'bg-gray-100 text-gray-700';
      case 'Archived': return 'bg-red-100 text-red-700';
      default: return 'bg-emerald-100 text-emerald-700';
    }
  };

  const userStatus = (() => {
    if (user.role === 'player') {
      const pp = Array.isArray(user.player_profiles) ? user.player_profiles[0] : user.player_profiles;
      return pp?.status || 'Active';
    }
    if (user.role === 'coach') return user.coach_status || 'Active';
    return 'Active';
  })();

  return (
    <>
      <div
        onClick={() => setShowEdit(true)}
        className="bg-gray-50 rounded-lg p-4 hover:bg-gray-100 transition cursor-pointer"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-semibold">
              {user.full_name.charAt(0)}
            </div>
            <div>
              <h4
                className="font-semibold text-blue-600 hover:text-blue-800 hover:underline cursor-pointer inline-flex items-center gap-1.5"
                onClick={(e) => { e.stopPropagation(); onNavigateToProfile && onNavigateToProfile(user.id); }}
              >
                {user.full_name}
                <ProgramStatusBadge status={programStatus} size={15} />
              </h4>
              <p className="text-sm text-gray-600">{user.email}</p>
              {user.team_members && user.team_members.length > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  Teams: {user.team_members.map(tm => tm.teams.name).join(', ')}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-start space-x-3">
            <div className="flex flex-col items-end gap-1">
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${getRoleBadgeColor(user.role)}`}>
                {user.is_intern ? 'intern' : user.role}
              </span>
              <span className={`px-3 py-0.5 rounded-full text-[10px] font-medium ${getStatusBadgeColor(userStatus)}`}>
                {userStatus}
              </span>
              {user.secondary_role && user.secondary_role !== user.role && (
                <span className={`px-3 py-0.5 rounded-full text-[10px] font-medium ${getRoleBadgeColor(user.secondary_role)} ring-1 ring-inset ring-gray-300`}>
                  +{user.secondary_role}
                </span>
              )}
            </div>
            <Edit2 size={16} className="text-gray-400 mt-1" />
          </div>
        </div>
      </div>

      {showEdit && (
        <EditUserModal
          user={user}
          teams={teams}
          userId={userId}
          callerRole={userRole}
          onClose={() => setShowEdit(false)}
          onSuccess={() => {
            setShowEdit(false);
            refreshUsers();
          }}
        />
      )}
    </>
  );
}

function EditUserModal({ user, teams, userId, callerRole, onClose, onSuccess }) {
  useModalTracking('EditUserModal');
  const profile = Array.isArray(user.player_profiles) ? user.player_profiles[0] : user.player_profiles || null;
  const currentTeamIds = (user.team_members || []).map(tm => tm.team_id);

  const [formData, setFormData] = useState({
    full_name: user.full_name || '',
    email: user.email || '',
    phone: user.phone || '',
    // Interns are stored as role='coach' with is_intern=true. Surface as 'intern' in the form.
    role: user.is_intern ? 'intern' : (user.role || 'player'),
    secondary_role: user.secondary_role || '',
    height: user.height || '',
    weight: user.weight || '',
    jersey_number: profile?.jersey_number || '',
    position: profile?.position || '',
    grade: profile?.grade || '',
    bats: profile?.bats || 'Right',
    throws: profile?.throws || 'Right',
  });
  const [assignedTeamIds, setAssignedTeamIds] = useState(currentTeamIds);
  const [addTeamId, setAddTeamId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetSending, setResetSending] = useState(false);
  // #312: manual password set, for when the reset-link email never reaches
  // the player. Admin + coach — see EditUserModal's render for the role check.
  const [manualResetOpen, setManualResetOpen] = useState(false);
  const [manualPassword, setManualPassword] = useState('');
  const [manualResetSaving, setManualResetSaving] = useState(false);
  // A coach may only manually reset a player's password, never another
  // admin's or coach's — mirrors the server-side check in
  // reset-user-password (the actual enforcement point). Without this, the
  // button would just 403 for a coach editing another staff member.
  const canManualReset = callerRole === 'admin' || (callerRole === 'coach' && user.role !== 'admin' && user.role !== 'coach');

  const handleManualPasswordReset = async () => {
    if (manualPassword.length < 8) { alert('Password must be at least 8 characters.'); return; }
    if (!window.confirm(`Set a new password for ${user.full_name}? They will need this new password to log in, and any device where they're currently logged in will be signed out.`)) return;
    setManualResetSaving(true);
    try {
      await resetUserPassword(user.id, manualPassword);
      setManualPassword('');
      setManualResetOpen(false);
      alert(`Password updated for ${user.full_name}.`);
    } catch (err) {
      alert('Error resetting password: ' + formatUserError(err));
    } finally {
      setManualResetSaving(false);
    }
  };

  const handleSendPasswordReset = async () => {
    setResetSending(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}/?type=recovery`,
    });
    setResetSending(false);
    if (resetError) { alert('Failed to send reset email: ' + formatUserError(resetError)); return; }
    setResetSent(true);
  };

  const availableTeams = teams.filter(t => !assignedTeamIds.includes(t.id));

  const handleAddTeam = () => {
    if (addTeamId && !assignedTeamIds.includes(addTeamId)) {
      setAssignedTeamIds([...assignedTeamIds, addTeamId]);
      setAddTeamId('');
    }
  };

  const handleRemoveTeam = (teamId) => {
    setAssignedTeamIds(assignedTeamIds.filter(id => id !== teamId));
  };

  const handleSave = async () => {
    trackAction('save_user');
    setLoading(true);
    setError('');
    try {
      const isIntern = formData.role === 'intern';
      const dbRole = isIntern ? 'coach' : formData.role;

      // Guard: don't allow the last admin in the org to be demoted, or the
      // current admin to demote themselves out of admin (lockout).
      if (user.role === 'admin' && dbRole !== 'admin') {
        if (user.id === userId) {
          throw new Error('You cannot demote yourself out of admin. Ask another admin to do it.');
        }
        const { count } = await supabase
          .from('users')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin');
        if ((count ?? 0) <= 1) {
          throw new Error('Cannot demote the last admin — promote another user first.');
        }
      }

      // Guard: secondary_role can't equal primary role.
      if (formData.secondary_role && formData.secondary_role === dbRole) {
        throw new Error('Secondary role must differ from the primary role.');
      }

      // 0. Sync auth email if changed
      if (formData.email !== user.email) {
        await updateAuthUserEmail(user.id, formData.email);
      }

      // 1. Update users table
      const { error: userError } = await supabase
        .from('users')
        .update({
          full_name: formData.full_name,
          email: formData.email,
          phone: formData.phone || null,
          role: dbRole,
          is_intern: isIntern,
          secondary_role: formData.secondary_role || null,
          height: formData.height || null,
          weight: formData.weight || null,
        })
        .eq('id', user.id);
      if (userError) throw userError;

      // 2. Update player_profiles if player
      if (dbRole === 'player' && profile?.id) {
        const { error: profileError } = await supabase
          .from('player_profiles')
          .update({
            jersey_number: formData.jersey_number || null,
            position: formData.position || null,
            grade: formData.grade || null,
            bats: formData.bats,
            throws: formData.throws,
          })
          .eq('id', profile.id);
        if (profileError) throw profileError;
      } else if (formData.role === 'player' && !profile) {
        // Create player profile if switching to player role
        const { error: profileError } = await supabase
          .from('player_profiles')
          .insert({
            user_id: user.id,
            jersey_number: formData.jersey_number || null,
            position: formData.position || null,
            grade: formData.grade || null,
            bats: formData.bats,
            throws: formData.throws,
          });
        if (profileError) throw profileError;
      }

      // 3. Sync team assignments. Run removals + additions in parallel and
      // collect failures so the user gets a clear partial-failure signal
      // instead of silently leaving the user on the wrong teams.
      const teamsToAdd = assignedTeamIds.filter(id => !currentTeamIds.includes(id));
      const teamsToRemove = currentTeamIds.filter(id => !assignedTeamIds.includes(id));

      const removeResults = await Promise.all(
        teamsToRemove.map(teamId =>
          supabase.from('team_members').delete().eq('user_id', user.id).eq('team_id', teamId)
        )
      );
      const addResults = await Promise.all(
        teamsToAdd.map(teamId =>
          supabase.from('team_members').insert({
            team_id: teamId,
            user_id: user.id,
            // team_members role vocabulary is player/coach only. dbRole already
            // maps intern->coach; also fold admin->coach here.
            role: dbRole === 'admin' ? 'coach' : dbRole,
          })
        )
      );
      const teamErrors = [...removeResults, ...addResults]
        .map(r => r.error).filter(Boolean);
      if (teamErrors.length > 0) {
        throw new Error(`Team sync partially failed (${teamErrors.length} error${teamErrors.length === 1 ? '' : 's'}). Refresh and retry.`);
      }

      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    trackAction('delete_user');
    setDeleting(true);
    try {
      if (user.id === userId) {
        throw new Error('You cannot delete your own account.');
      }
      if (user.role === 'admin') {
        const { count } = await supabase
          .from('users')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin');
        if ((count ?? 0) <= 1) {
          throw new Error('Cannot delete the last admin — promote another user first.');
        }
      }
      await deleteAuthUser(user.id); // Edge function deletes public.users row + auth user
      onSuccess();
    } catch (err) {
      console.error('Error deleting user:', err);
      alert('Error deleting user: ' + formatUserError(err));
      setDeleting(false);
    }
  };

  const inputClass = "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Edit User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Full Name</label>
              <input
                type="text"
                value={formData.full_name}
                onChange={(e) => setFormData({...formData, full_name: e.target.value})}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({...formData, email: e.target.value})}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData({...formData, phone: e.target.value})}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({...formData, role: e.target.value})}
                className={inputClass}
              >
                <option value="player">Player</option>
                <option value="coach">Coach</option>
                <option value="intern">Intern</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Secondary Role <span className="text-xs text-gray-500 font-normal">(lets the user toggle views)</span></label>
              <select
                value={formData.secondary_role || ''}
                onChange={(e) => setFormData({...formData, secondary_role: e.target.value})}
                className={inputClass}
              >
                <option value="">None</option>
                {['player', 'coach', 'admin'].filter(r => r !== (formData.role === 'intern' ? 'coach' : formData.role)).map(r => (
                  <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Height</label>
              <input
                type="text"
                placeholder="e.g., 6'2&quot;, 72 in"
                value={formData.height}
                onChange={(e) => setFormData({...formData, height: e.target.value})}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Weight</label>
              <input
                type="text"
                placeholder="e.g., 185 lbs"
                value={formData.weight}
                onChange={(e) => setFormData({...formData, weight: e.target.value})}
                className={inputClass}
              />
            </div>
          </div>

          {/* Team Assignments */}
          <div className="pt-4 border-t border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">Team Assignments</label>
            {assignedTeamIds.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {assignedTeamIds.map(tid => {
                  const team = teams.find(t => t.id === tid);
                  return (
                    <span key={tid} className="inline-flex items-center bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-sm">
                      {team?.name || 'Unknown'}
                      <button onClick={() => handleRemoveTeam(tid)} className="ml-2 text-blue-400 hover:text-red-600">
                        <X size={14} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            {availableTeams.length > 0 && (
              <div className="flex items-center space-x-2">
                <select
                  value={addTeamId}
                  onChange={(e) => setAddTeamId(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Add to team...</option>
                  {availableTeams.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleAddTeam}
                  disabled={!addTeamId}
                  className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition disabled:opacity-50"
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </div>

          {/* Player-specific fields */}
          {formData.role === 'player' && (
            <div className="pt-4 border-t border-gray-200">
              <h4 className="font-semibold text-gray-900 mb-4">Player Details</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Jersey Number</label>
                  <input
                    type="text"
                    value={formData.jersey_number}
                    onChange={(e) => setFormData({...formData, jersey_number: e.target.value})}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Position</label>
                  <input
                    type="text"
                    placeholder="e.g., SS, P, OF"
                    value={formData.position}
                    onChange={(e) => setFormData({...formData, position: e.target.value})}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Grade</label>
                  <input
                    type="text"
                    placeholder="e.g., 8th, 10th"
                    value={formData.grade}
                    onChange={(e) => setFormData({...formData, grade: e.target.value})}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Bats</label>
                  <select
                    value={formData.bats}
                    onChange={(e) => setFormData({...formData, bats: e.target.value})}
                    className={inputClass}
                  >
                    <option value="Right">Right</option>
                    <option value="Left">Left</option>
                    <option value="Switch">Switch</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Throws</label>
                  <select
                    value={formData.throws}
                    onChange={(e) => setFormData({...formData, throws: e.target.value})}
                    className={inputClass}
                  >
                    <option value="Right">Right</option>
                    <option value="Left">Left</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* #312: manual password reset — admin + coach, per the business
              owner's explicit 2026-08-12 reply ("I would like admins and
              coaches to be able to do this"), widened from the original
              admin-only. Deliberately separate from the "Reset Password"
              email-link flow above; this is for when that email never
              reaches the player. A coach only sees this for player accounts
              — see canManualReset above. */}
          {canManualReset && manualResetOpen && (
            <div className="border border-gray-200 rounded-lg p-4 space-y-2">
              <label className="block text-sm font-medium text-gray-700">New password for {user.full_name}</label>
              <input
                type="text"
                value={manualPassword}
                onChange={(e) => setManualPassword(e.target.value)}
                placeholder="At least 8 characters"
                className={inputClass}
              />
              <p className="text-xs text-gray-500">They'll need to log in with this new password. Any device where they're currently signed in will be signed out.</p>
              <div className="flex justify-end space-x-2 pt-1">
                <button
                  onClick={() => { setManualResetOpen(false); setManualPassword(''); }}
                  className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleManualPasswordReset}
                  disabled={manualResetSaving}
                  className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {manualResetSaving ? 'Saving...' : 'Set Password'}
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-gray-200">
            {user.id !== userId && callerRole === 'admin' ? (
              confirmDelete ? (
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-red-600">Delete this user?</span>
                  <button
                    onClick={handleDeleteUser}
                    disabled={deleting}
                    className="px-3 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Yes, Delete'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-3 py-1.5 border border-gray-300 text-gray-700 rounded text-sm hover:bg-gray-50"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-red-600 hover:text-red-700 text-sm font-medium flex items-center space-x-1"
                >
                  <Trash2 size={14} />
                  <span>Delete User</span>
                </button>
              )
            ) : <div />}

            <div className="flex items-center space-x-3">
              <button
                onClick={handleSendPasswordReset}
                disabled={resetSending || resetSent}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition disabled:opacity-50 flex items-center space-x-1"
                title="Send password reset email"
              >
                <Mail size={14} />
                <span>{resetSent ? 'Reset email sent' : resetSending ? 'Sending...' : 'Reset Password'}</span>
              </button>
              {canManualReset && (
                <button
                  onClick={() => setManualResetOpen(v => !v)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition flex items-center space-x-1"
                  title="Set a new password directly, without sending an email"
                >
                  <Key size={14} />
                  <span>Manual Reset</span>
                </button>
              )}
              <button
                onClick={onClose}
                className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={loading}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Returns the school grade label for a date-of-birth string (YYYY-MM-DD),
// using September 1 as the enrollment cutoff.
function gradeFromDOB(dob) {
  if (!dob) return '';
  const birth = new Date(dob + 'T00:00:00');
  const today = new Date();
  const cutoffYear = today >= new Date(today.getFullYear(), 8, 1)
    ? today.getFullYear()
    : today.getFullYear() - 1;
  let age = cutoffYear - birth.getFullYear();
  if (birth.getMonth() > 8 || (birth.getMonth() === 8 && birth.getDate() > 1)) age--;
  const grades = {
    5: 'K', 6: '1st', 7: '2nd', 8: '3rd', 9: '4th', 10: '5th',
    11: '6th', 12: '7th', 13: '8th', 14: 'Freshman', 15: 'Sophomore',
    16: 'Junior', 17: 'Senior',
  };
  return grades[age] || (age >= 18 ? 'Senior' : '');
}

// #310: exported so FacilityEventDetail (Schedule.js) can reuse this for
// "create a new player inline" instead of a second signup form. onSuccess
// now also receives the new user's id/full_name (existing AdminSettings.js
// caller below ignores the extra args — backward compatible).
export function CreateUserModal({ teams, callerRole, onClose, onSuccess }) {
  useModalTracking('CreateUserModal');
  const isCoachCaller = callerRole === 'coach';
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    full_name: '',
    role: 'player',
    phone: '',
    date_of_birth: '',
    height: '',
    weight: '',
    team_id: '',
    // Player-specific fields
    jersey_number: '',
    position: '',
    grade: '',
    bats: 'Right',
    throws: 'Right'
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    let newUserId = null;

    try {
      const isIntern = formData.role === 'intern';
      const dbRole = isIntern ? 'coach' : formData.role;

      // 1. Create auth user via edge function (admin API — does NOT affect current session)
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${supabaseUrl}/functions/v1/create-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': supabaseAnonKey,
          },
          body: JSON.stringify({
            email: formData.email,
            password: formData.password,
            full_name: formData.full_name,
            role: dbRole,
          }),
        }
      );
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to create auth user');

      newUserId = result.user_id;

      // 2. Insert into users table
      const { error: userError } = await supabase
        .from('users')
        .insert({
          id: newUserId,
          email: formData.email,
          full_name: formData.full_name,
          role: dbRole,
          is_intern: isIntern,
          phone: formData.phone || null,
          date_of_birth: formData.date_of_birth || null,
          height: formData.height || null,
          weight: formData.weight || null
        });

      if (userError) throw userError;

      // 3. If player, create player profile
      if (dbRole === 'player') {
        const { error: profileError } = await supabase
          .from('player_profiles')
          .insert({
            user_id: newUserId,
            jersey_number: formData.jersey_number || null,
            position: formData.position || null,
            grade: formData.grade || null,
            bats: formData.bats,
            throws: formData.throws
          });

        if (profileError) throw profileError;
      }

      // 4. If team selected, add to team
      if (formData.team_id) {
        const { error: teamError } = await supabase
          .from('team_members')
          .insert({
            team_id: formData.team_id,
            user_id: newUserId,
            role: dbRole === 'admin' ? 'coach' : dbRole
          });

        if (teamError) throw teamError;
      }

      newUserId = null; // Clear so catch block doesn't delete a successfully created user
      alert('User created successfully!');
      onSuccess(result.user_id, formData.full_name);
    } catch (err) {
      // If auth user was created but DB inserts failed, clean up the orphaned auth user
      if (newUserId) {
        try { await deleteAuthUser(newUserId); } catch (_) {}
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Create New User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded text-sm">
            <strong>Note:</strong> User will receive a confirmation email and must verify before logging in. For testing, you can manually confirm users in Supabase Authentication dashboard.
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Full Name *
              </label>
              <input
                type="text"
                required
                value={formData.full_name}
                onChange={(e) => setFormData({...formData, full_name: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email *
              </label>
              <input
                type="email"
                required
                value={formData.email}
                onChange={(e) => setFormData({...formData, email: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Password *
              </label>
              <input
                type="password"
                required
                value={formData.password}
                onChange={(e) => setFormData({...formData, password: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Role *
              </label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({...formData, role: e.target.value})}
                disabled={isCoachCaller}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
              >
                <option value="player">Player</option>
                {!isCoachCaller && <option value="coach">Coach</option>}
                {!isCoachCaller && <option value="intern">Intern</option>}
                {!isCoachCaller && <option value="admin">Admin</option>}
              </select>
              {isCoachCaller && (
                <p className="mt-1 text-xs text-gray-500">Coaches can only create player accounts.</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Phone
              </label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => setFormData({...formData, phone: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Date of Birth
              </label>
              <input
                type="date"
                value={formData.date_of_birth}
                onChange={(e) => {
                  const dob = e.target.value;
                  const autoGrade = gradeFromDOB(dob);
                  const updates = { date_of_birth: dob };
                  if (autoGrade) updates.grade = autoGrade;
                  if (!formData.team_id && autoGrade) {
                    const hsGrades = ['Freshman', 'Sophomore', 'Junior', 'Senior'];
                    const keyword = hsGrades.includes(autoGrade) ? 'high school' : 'middle school';
                    const match = teams.find(t => t.name.toLowerCase().includes(keyword));
                    if (match) updates.team_id = match.id;
                  }
                  setFormData({ ...formData, ...updates });
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Height
              </label>
              <input
                type="text"
                placeholder="e.g., 6'2&quot;, 72 in"
                value={formData.height}
                onChange={(e) => setFormData({...formData, height: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Weight
              </label>
              <input
                type="text"
                placeholder="e.g., 185 lbs"
                value={formData.weight}
                onChange={(e) => setFormData({...formData, weight: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Assign to Team
              </label>
              <select
                value={formData.team_id}
                onChange={(e) => setFormData({...formData, team_id: e.target.value})}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">No team</option>
                {teams.map(team => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </div>
          </div>

          {formData.role === 'player' && (
            <>
              <div className="pt-4 border-t border-gray-200">
                <h4 className="font-semibold text-gray-900 mb-4">Player Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Jersey Number
                    </label>
                    <input
                      type="text"
                      value={formData.jersey_number}
                      onChange={(e) => setFormData({...formData, jersey_number: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Position
                    </label>
                    <input
                      type="text"
                      placeholder="e.g., SS, P, OF"
                      value={formData.position}
                      onChange={(e) => setFormData({...formData, position: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Grade
                    </label>
                    <input
                      type="text"
                      placeholder="e.g., 8th, 10th"
                      value={formData.grade}
                      onChange={(e) => setFormData({...formData, grade: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Bats
                    </label>
                    <select
                      value={formData.bats}
                      onChange={(e) => setFormData({...formData, bats: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="Right">Right</option>
                      <option value="Left">Left</option>
                      <option value="Switch">Switch</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Throws
                    </label>
                    <select
                      value={formData.throws}
                      onChange={(e) => setFormData({...formData, throws: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="Right">Right</option>
                      <option value="Left">Left</option>
                    </select>
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="flex space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TeamsTab({ teams, users, showCreateTeam, setShowCreateTeam, refreshTeams, refreshUsers }) {
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTeams = teams.filter(t => {
    if ((t.team_type || 'team') === 'training') return false;
    const q = searchQuery.toLowerCase();
    return t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">All Teams</h3>
        <button
          onClick={() => setShowCreateTeam(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
        >
          <Plus size={18} />
          <span>Create Team</span>
        </button>
      </div>

      <div className="relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search teams by name or description..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredTeams.map(team => (
          <div
            key={team.id}
            onClick={() => setSelectedTeam(team)}
            className="bg-gray-50 rounded-lg p-6 hover:bg-gray-100 transition cursor-pointer"
          >
            <div className="flex items-start justify-between">
              <div>
                <h4 className="text-xl font-semibold text-gray-900">{team.name}</h4>
                {team.description && (
                  <p className="text-sm text-gray-600 mt-1">{team.description}</p>
                )}
                <p className="text-xs text-gray-500 mt-2">
                  Created {new Date(team.created_at).toLocaleDateString()}
                </p>
              </div>
              <ChevronRight className="text-gray-400 mt-1" size={20} />
            </div>
          </div>
        ))}
      </div>

      {showCreateTeam && (
        <CreateTeamModal
          onClose={() => setShowCreateTeam(false)}
          onSuccess={() => {
            setShowCreateTeam(false);
            refreshTeams();
          }}
        />
      )}

      {selectedTeam && (
        <TeamDetailModal
          team={selectedTeam}
          users={users}
          onClose={() => setSelectedTeam(null)}
          onRefresh={() => {
            refreshTeams();
            refreshUsers();
          }}
        />
      )}
    </div>
  );
}

function TeamDetailModal({ team, users, onClose, onRefresh }) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description || '');
  const [teamType, setTeamType] = useState(team.team_type || 'team');
  const [ageGroup, setAgeGroup] = useState(team.age_group || '');
  const [editing, setEditing] = useState(false);
  const [members, setMembers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState('player');
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [showMemberDropdown, setShowMemberDropdown] = useState(false);
  const memberDropdownRef = useRef(null);

  // Prospects state
  const [teamProspects, setTeamProspects] = useState([]);
  const [allProspects, setAllProspects] = useState([]);
  const [prospectSearch, setProspectSearch] = useState('');
  const [showProspectDropdown, setShowProspectDropdown] = useState(false);
  const [addProspectId, setAddProspectId] = useState('');
  const [addingProspect, setAddingProspect] = useState(false);
  const prospectDropdownRef = useRef(null);

  const fetchMembers = async () => {
    const { data, error } = await supabase
      .from('team_members')
      .select('*, users(id, full_name, email, role, player_profiles!player_profiles_user_id_fkey(status))')
      .eq('team_id', team.id);

    if (error) {
      console.error('Error fetching members:', error);
    } else {
      setMembers(data || []);
    }
    setLoading(false);
  };

  const fetchAllProspects = async () => {
    const { data } = await supabase.from('prospects').select('*').order('full_name');
    setAllProspects(data || []);
  };

  const fetchTeamProspects = async () => {
    const { data } = await supabase
      .from('team_prospects')
      .select('*, prospects(id, full_name, email, position, grade)')
      .eq('team_id', team.id);
    setTeamProspects(data || []);
  };

  useEffect(() => {
    fetchMembers();
    fetchAllProspects();
    fetchTeamProspects();
  }, [team.id]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (memberDropdownRef.current && !memberDropdownRef.current.contains(e.target)) {
        setShowMemberDropdown(false);
      }
      if (prospectDropdownRef.current && !prospectDropdownRef.current.contains(e.target)) {
        setShowProspectDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const memberUserIds = new Set(members.map(m => m.user_id));
  const availableUsers = users.filter(u => !memberUserIds.has(u.id));
  const filteredAvailableUsers = availableUsers.filter(u => {
    const q = memberSearch.toLowerCase();
    if (!q) return true;
    return u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  const handleSaveDetails = async () => {
    trackAction('save_team_details');
    setSaving(true);
    setError('');
    const { error: updateError } = await supabase
      .from('teams')
      .update({ name, description: description || null, team_type: teamType || 'team', age_group: ageGroup || null })
      .eq('id', team.id);

    if (updateError) {
      setError(updateError.message);
    } else {
      setEditing(false);
      onRefresh();
    }
    setSaving(false);
  };

  const handleAddMember = async () => {
    if (!addUserId) return;
    setAdding(true);
    setError('');

    const { error: insertError } = await supabase
      .from('team_members')
      .insert({
        team_id: team.id,
        user_id: addUserId,
        role: addRole,
      });

    if (insertError) {
      setError(insertError.message);
    } else {
      setAddUserId('');
      setMemberSearch('');
      fetchMembers();
      onRefresh();
    }
    setAdding(false);
  };

  const handleRemoveMember = async (memberId) => {
    const { error: deleteError } = await supabase
      .from('team_members')
      .delete()
      .eq('id', memberId);

    if (deleteError) {
      setError(deleteError.message);
    } else {
      fetchMembers();
      onRefresh();
    }
  };

  const teamProspectIds = new Set(teamProspects.map(tp => tp.prospect_id));
  const availableProspects = allProspects.filter(p => !teamProspectIds.has(p.id));
  const filteredAvailableProspects = availableProspects.filter(p => {
    const q = prospectSearch.toLowerCase();
    if (!q) return true;
    return (p.full_name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q);
  });

  const handleAddProspect = async () => {
    if (!addProspectId) return;
    setAddingProspect(true);
    setError('');
    const { error: insertError } = await supabase.from('team_prospects').insert({
      team_id: team.id,
      prospect_id: addProspectId,
    });
    if (insertError) setError(insertError.message);
    else {
      setAddProspectId('');
      setProspectSearch('');
      fetchTeamProspects();
    }
    setAddingProspect(false);
  };

  const handleRemoveProspect = async (tpId) => {
    const { error: deleteError } = await supabase.from('team_prospects').delete().eq('id', tpId);
    if (deleteError) setError(deleteError.message);
    else fetchTeamProspects();
  };

  const handleDeleteTeam = async () => {
    trackAction('delete_team');
    setSaving(true);
    // Delete child rows first (team_members + team_prospects), then the team, so
    // a non-cascading FK on team_prospects doesn't block the delete or orphan rows.
    await supabase.from('team_members').delete().eq('team_id', team.id);
    await supabase.from('team_prospects').delete().eq('team_id', team.id);
    const { error: deleteError } = await supabase
      .from('teams')
      .delete()
      .eq('id', team.id);

    if (deleteError) {
      setError(deleteError.message);
      setSaving(false);
    } else {
      onRefresh();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Team Details</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          {/* Team Name & Description */}
          <div>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Team Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows="2"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                    <select
                      value={teamType}
                      onChange={(e) => setTeamType(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="team">Team</option>
                      <option value="training">Training Group</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Age Group</label>
                    <input
                      type="text"
                      value={ageGroup}
                      onChange={(e) => setAgeGroup(e.target.value)}
                      placeholder="e.g., 14u, 16u, 18u"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={handleSaveDetails}
                    disabled={saving || !name.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center space-x-1"
                  >
                    <Save size={14} />
                    <span>{saving ? 'Saving...' : 'Save'}</span>
                  </button>
                  <button
                    onClick={() => { setEditing(false); setName(team.name); setDescription(team.description || ''); setTeamType(team.team_type || 'team'); setAgeGroup(team.age_group || ''); }}
                    className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="text-lg font-semibold text-gray-900">{team.name}</h4>
                  {team.description && <p className="text-sm text-gray-600 mt-1">{team.description}</p>}
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${team.team_type === 'training' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {team.team_type === 'training' ? 'Training Group' : 'Team'}
                    </span>
                    {team.age_group && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">{team.age_group}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setEditing(true)}
                  className="text-gray-400 hover:text-blue-600 ml-2"
                >
                  <Edit2 size={16} />
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Members Column */}
            <div>
              {/* Members List */}
              <div>
                <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                  Members ({members.length})
                </h4>
                {loading ? (
                  <p className="text-gray-500 text-sm">Loading members...</p>
                ) : members.length === 0 ? (
                  <p className="text-gray-500 text-sm py-4 text-center">No members yet</p>
                ) : (
                  <div className="space-y-2">
                    {members.map(member => (
                      <div key={member.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
                            {member.users?.full_name?.charAt(0) || '?'}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{member.users?.full_name}</p>
                            <p className="text-xs text-gray-500">{member.users?.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          {member.role === 'player' && (() => {
                            const profile = member.users?.player_profiles;
                            const status = Array.isArray(profile) ? profile[0]?.status : profile?.status;
                            return status ? (
                              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                                {status}
                              </span>
                            ) : null;
                          })()}
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">
                            {member.role}
                          </span>
                          <button
                            onClick={() => handleRemoveMember(member.id)}
                            className="text-gray-400 hover:text-red-600 transition"
                            title="Remove from team"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Member */}
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                  Add Member
                </h4>
                <div className="flex space-x-2">
                  <div className="flex-1 relative" ref={memberDropdownRef}>
                    <input
                      type="text"
                      value={memberSearch}
                      onChange={(e) => {
                        setMemberSearch(e.target.value);
                        setAddUserId('');
                        setShowMemberDropdown(true);
                      }}
                      onFocus={() => setShowMemberDropdown(true)}
                      placeholder="Search users..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {showMemberDropdown && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {filteredAvailableUsers.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-gray-500">No users found</div>
                        ) : (
                          filteredAvailableUsers.map(u => (
                            <button
                              key={u.id}
                              type="button"
                              onClick={() => {
                                setAddUserId(u.id);
                                setMemberSearch(u.full_name);
                                setShowMemberDropdown(false);
                              }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition flex items-center justify-between"
                            >
                              <span>{u.full_name}</span>
                              <span className="text-xs text-gray-400">{u.email}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <select
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="player">Player</option>
                    <option value="coach">Coach</option>
                  </select>
                  <button
                    onClick={handleAddMember}
                    disabled={!addUserId || adding}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center space-x-1"
                  >
                    <UserPlus size={14} />
                    <span>{adding ? '...' : 'Add'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Prospects Column */}
            <div>
              <div>
                <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                  Prospects ({teamProspects.length})
                </h4>
                {teamProspects.length === 0 ? (
                  <p className="text-gray-500 text-sm py-4 text-center">No prospects yet</p>
                ) : (
                  <div className="space-y-2">
                    {teamProspects.map(tp => (
                      <div key={tp.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 bg-purple-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
                            {tp.prospects?.full_name?.charAt(0) || '?'}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{tp.prospects?.full_name}</p>
                            <p className="text-xs text-gray-500">{tp.prospects?.email || tp.prospects?.position || ''}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemoveProspect(tp.id)}
                          className="text-gray-400 hover:text-red-600 transition"
                          title="Remove prospect"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Prospect */}
              <div className="mt-4">
                <h4 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
                  Add Prospect
                </h4>
                <div className="flex space-x-2">
                  <div className="flex-1 relative" ref={prospectDropdownRef}>
                    <input
                      type="text"
                      value={prospectSearch}
                      onChange={(e) => {
                        setProspectSearch(e.target.value);
                        setAddProspectId('');
                        setShowProspectDropdown(true);
                      }}
                      onFocus={() => setShowProspectDropdown(true)}
                      placeholder="Search prospects..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {showProspectDropdown && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {filteredAvailableProspects.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-gray-500">No prospects found</div>
                        ) : (
                          filteredAvailableProspects.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                setAddProspectId(p.id);
                                setProspectSearch(p.full_name);
                                setShowProspectDropdown(false);
                              }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-purple-50 transition flex items-center justify-between"
                            >
                              <span>{p.full_name}</span>
                              <span className="text-xs text-gray-400">{p.email || p.position || ''}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleAddProspect}
                    disabled={!addProspectId || addingProspect}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition disabled:opacity-50 flex items-center space-x-1"
                  >
                    <UserPlus size={14} />
                    <span>{addingProspect ? '...' : 'Add'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Delete Team */}
          <div className="pt-4 border-t border-gray-200">
            {confirmDelete ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm text-red-700 mb-3">
                  Delete <strong>{team.name}</strong>? This will remove all members from the team. This cannot be undone.
                </p>
                <div className="flex space-x-2">
                  <button
                    onClick={handleDeleteTeam}
                    disabled={saving}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition disabled:opacity-50"
                  >
                    {saving ? 'Deleting...' : 'Yes, Delete'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-red-600 hover:text-red-700 text-sm font-medium flex items-center space-x-1"
              >
                <Trash2 size={14} />
                <span>Delete Team</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// PROSPECTS TAB
// ============================================

function ProspectsTab({ prospects, teams, showCreateProspect, setShowCreateProspect, refreshProspects }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingProspect, setEditingProspect] = useState(null);

  const filteredProspects = prospects.filter(p => {
    const q = searchQuery.toLowerCase();
    return (p.full_name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q);
  });

  const handleDeleteProspect = async (id) => {
    if (!window.confirm('Delete this prospect?')) return;
    const { error } = await supabase.from('prospects').delete().eq('id', id);
    if (error) alert('Error deleting prospect: ' + formatUserError(error));
    else refreshProspects();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">All Prospects</h3>
        <button
          onClick={() => setShowCreateProspect(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
        >
          <Plus size={18} />
          <span>Create Prospect</span>
        </button>
      </div>

      <div className="relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search prospects by name or email..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        />
      </div>

      {filteredProspects.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Users size={48} className="mx-auto mb-4 text-gray-300" />
          <p>{searchQuery ? 'No prospects match your search.' : 'No prospects yet. Create one to get started.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredProspects.map(prospect => (
            <div key={prospect.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-purple-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
                  {(prospect.full_name || '?').charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">{prospect.full_name}</p>
                  <p className="text-xs text-gray-500">{prospect.email || 'No email'}</p>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                {prospect.position && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">{prospect.position}</span>
                )}
                {prospect.grade && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-700">{prospect.grade}</span>
                )}
                <button onClick={() => setEditingProspect(prospect)} className="text-gray-400 hover:text-blue-600 transition">
                  <Edit2 size={14} />
                </button>
                <button onClick={() => handleDeleteProspect(prospect.id)} className="text-gray-400 hover:text-red-600 transition">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateProspect && (
        <CreateProspectModal
          teams={teams}
          onClose={() => setShowCreateProspect(false)}
          onSuccess={() => {
            setShowCreateProspect(false);
            refreshProspects();
          }}
        />
      )}

      {editingProspect && (
        <EditProspectModal
          prospect={editingProspect}
          teams={teams}
          onClose={() => setEditingProspect(null)}
          onSuccess={() => {
            setEditingProspect(null);
            refreshProspects();
          }}
        />
      )}
    </div>
  );
}

function CreateProspectModal({ teams, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    height: '',
    weight: '',
    team_id: '',
    jersey_number: '',
    position: '',
    grade: '',
    bats: 'Right',
    throws: 'Right'
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState([]);
  const [searchingUsers, setSearchingUsers] = useState(false);

  useEffect(() => {
    if (userSearch.length < 2) { setUserResults([]); return; }
    const timeout = setTimeout(async () => {
      setSearchingUsers(true);
      const q = userSearch.toLowerCase();
      const { data: users } = await supabase.from('users').select('id, full_name, email, phone, height, weight, role').ilike('full_name', `%${q}%`).limit(8);
      if (users && users.length > 0) {
        const userIds = users.map(u => u.id);
        const { data: profiles } = await supabase.from('player_profiles').select('user_id, jersey_number, position, grade, bats, throws').in('user_id', userIds);
        const profileMap = {};
        (profiles || []).forEach(p => { profileMap[p.user_id] = p; });
        setUserResults(users.map(u => ({ ...u, profile: profileMap[u.id] || null })));
      } else {
        setUserResults([]);
      }
      setSearchingUsers(false);
    }, 300);
    return () => clearTimeout(timeout);
  }, [userSearch]);

  const selectUser = (user) => {
    const p = user.profile || {};
    setFormData({
      full_name: user.full_name || '',
      email: user.email || '',
      phone: user.phone || '',
      height: user.height || '',
      weight: user.weight || '',
      team_id: '',
      jersey_number: p.jersey_number || '',
      position: p.position || '',
      grade: p.grade || '',
      bats: p.bats || 'Right',
      throws: p.throws || 'Right',
    });
    setSelectedUserId(user.id);
    setUserSearch('');
    setUserResults([]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error: insertError } = await supabase.from('prospects').insert({
        name: formData.full_name,
        full_name: formData.full_name,
        email: formData.email || null,
        phone: formData.phone || null,
        height: formData.height || null,
        weight: formData.weight || null,
        team_id: formData.team_id || null,
        jersey_number: formData.jersey_number || null,
        position: formData.position || null,
        grade: formData.grade || null,
        bats: formData.bats,
        throws: formData.throws,
        player_id: selectedUserId || null,
      });
      if (insertError) throw insertError;
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Create Prospect</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

          {/* Import from existing user */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <label className="block text-sm font-medium text-blue-900 mb-2">
              <UserPlus size={16} className="inline mr-1 -mt-0.5" />
              Import from Existing User
            </label>
            {selectedUserId ? (
              <div className="flex items-center justify-between bg-white border border-blue-300 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-900 font-medium">{formData.full_name} — fields populated below</span>
                <button type="button" onClick={() => { setSelectedUserId(null); setFormData({ full_name: '', email: '', phone: '', height: '', weight: '', team_id: '', jersey_number: '', position: '', grade: '', bats: 'Right', throws: 'Right' }); }} className="text-xs text-red-600 hover:text-red-800">Clear</button>
              </div>
            ) : (
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-blue-400" />
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search users by name to auto-fill..."
                  className="w-full pl-9 pr-4 py-2 border border-blue-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                />
                {userResults.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {userResults.map(u => (
                      <button key={u.id} type="button" onClick={() => selectUser(u)} className="w-full text-left px-4 py-2 hover:bg-blue-50 border-b border-gray-100 last:border-0">
                        <div className="text-sm font-medium text-gray-900">{u.full_name}</div>
                        <div className="text-xs text-gray-500">{u.email}{u.profile?.position ? ` · ${u.profile.position}` : ''}{u.role ? ` · ${u.role}` : ''}</div>
                      </button>
                    ))}
                  </div>
                )}
                {searchingUsers && <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm text-gray-500">Searching...</div>}
                {userSearch.length >= 2 && !searchingUsers && userResults.length === 0 && <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-sm text-gray-500">No users found</div>}
              </div>
            )}
            <p className="text-xs text-blue-700 mt-2">Search for an existing user to auto-fill their info, or fill in manually below.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Full Name *</label>
              <input type="text" required value={formData.full_name} onChange={(e) => setFormData({...formData, full_name: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input type="email" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
              <input type="tel" value={formData.phone} onChange={(e) => setFormData({...formData, phone: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Height</label>
              <input type="text" placeholder="e.g., 6'2&quot;, 72 in" value={formData.height} onChange={(e) => setFormData({...formData, height: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Weight</label>
              <input type="text" placeholder="e.g., 185 lbs" value={formData.weight} onChange={(e) => setFormData({...formData, weight: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Assign to Team</label>
              <select value={formData.team_id} onChange={(e) => setFormData({...formData, team_id: e.target.value})} className={inputClass}>
                <option value="">No team</option>
                {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-900 mb-4">Player Details</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Jersey Number</label>
                <input type="text" value={formData.jersey_number} onChange={(e) => setFormData({...formData, jersey_number: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Position</label>
                <input type="text" placeholder="e.g., SS, P, OF" value={formData.position} onChange={(e) => setFormData({...formData, position: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Grade</label>
                <input type="text" placeholder="e.g., 8th, 10th" value={formData.grade} onChange={(e) => setFormData({...formData, grade: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Bats</label>
                <select value={formData.bats} onChange={(e) => setFormData({...formData, bats: e.target.value})} className={inputClass}>
                  <option value="Right">Right</option>
                  <option value="Left">Left</option>
                  <option value="Switch">Switch</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Throws</label>
                <select value={formData.throws} onChange={(e) => setFormData({...formData, throws: e.target.value})} className={inputClass}>
                  <option value="Right">Right</option>
                  <option value="Left">Left</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">
              {loading ? 'Creating...' : 'Create Prospect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditProspectModal({ prospect, teams, onClose, onSuccess }) {
  const [formData, setFormData] = useState({
    full_name: prospect.full_name || '',
    email: prospect.email || '',
    phone: prospect.phone || '',
    height: prospect.height || '',
    weight: prospect.weight || '',
    team_id: prospect.team_id || '',
    jersey_number: prospect.jersey_number || '',
    position: prospect.position || '',
    grade: prospect.grade || '',
    bats: prospect.bats || 'Right',
    throws: prospect.throws || 'Right'
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setLoading(true);
    setError('');
    try {
      const { error: updateError } = await supabase.from('prospects').update({
        name: formData.full_name,
        full_name: formData.full_name,
        email: formData.email || null,
        phone: formData.phone || null,
        height: formData.height || null,
        weight: formData.weight || null,
        team_id: formData.team_id || null,
        jersey_number: formData.jersey_number || null,
        position: formData.position || null,
        grade: formData.grade || null,
        bats: formData.bats,
        throws: formData.throws,
      }).eq('id', prospect.id);
      if (updateError) throw updateError;
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 p-6 flex items-center justify-between">
          <h3 className="text-xl font-bold text-gray-900">Edit Prospect</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Full Name *</label>
              <input type="text" required value={formData.full_name} onChange={(e) => setFormData({...formData, full_name: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input type="email" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
              <input type="tel" value={formData.phone} onChange={(e) => setFormData({...formData, phone: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Height</label>
              <input type="text" value={formData.height} onChange={(e) => setFormData({...formData, height: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Weight</label>
              <input type="text" value={formData.weight} onChange={(e) => setFormData({...formData, weight: e.target.value})} className={inputClass} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Assign to Team</label>
              <select value={formData.team_id} onChange={(e) => setFormData({...formData, team_id: e.target.value})} className={inputClass}>
                <option value="">No team</option>
                {teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-gray-200">
            <h4 className="font-semibold text-gray-900 mb-4">Player Details</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Jersey Number</label>
                <input type="text" value={formData.jersey_number} onChange={(e) => setFormData({...formData, jersey_number: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Position</label>
                <input type="text" value={formData.position} onChange={(e) => setFormData({...formData, position: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Grade</label>
                <input type="text" value={formData.grade} onChange={(e) => setFormData({...formData, grade: e.target.value})} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Bats</label>
                <select value={formData.bats} onChange={(e) => setFormData({...formData, bats: e.target.value})} className={inputClass}>
                  <option value="Right">Right</option>
                  <option value="Left">Left</option>
                  <option value="Switch">Switch</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Throws</label>
                <select value={formData.throws} onChange={(e) => setFormData({...formData, throws: e.target.value})} className={inputClass}>
                  <option value="Right">Right</option>
                  <option value="Left">Left</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex space-x-3 pt-4">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition">Cancel</button>
            <button type="button" onClick={handleSave} disabled={loading || !formData.full_name.trim()} className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateTeamModal({ onClose, onSuccess }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [teamType, setTeamType] = useState('team');
  const [ageGroup, setAgeGroup] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const { error: insertError } = await supabase
      .from('teams')
      .insert({
        name,
        description: description || null,
        team_type: teamType || 'team',
        age_group: ageGroup || null,
      });

    if (insertError) {
      setError(insertError.message);
      setLoading(false);
    } else {
      onSuccess();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* #350: capped with a scrolling body so Cancel and Create Team stay on
          screen when the window is short. */}
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="border-b border-gray-200 p-6 flex items-center justify-between flex-shrink-0">
          <h3 className="text-xl font-bold text-gray-900">Create New Team</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Team Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g., 14U, 16U"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows="3"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Type</label>
              <select
                value={teamType}
                onChange={(e) => setTeamType(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="team">Team</option>
                <option value="training">Training Group</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Age Group</label>
              <input
                type="text"
                value={ageGroup}
                onChange={(e) => setAgeGroup(e.target.value)}
                placeholder="e.g., 14u, 16u"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

        </div>
        <div className="border-t border-gray-200 px-6 py-4 flex space-x-3 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Team'}
            </button>
        </div>
        </form>
      </div>
    </div>
  );
}

// ============================================
// CODES TAB
// ============================================

function CodesTab({ players }) {
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchCodes(); }, []);

  const fetchCodes = async () => {
    const { data, error } = await supabase
      .from('discount_codes')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) console.error('Error fetching codes:', error);
    else setCodes(data || []);
    setLoading(false);
  };

  const addCode = async () => {
    const { data, error } = await supabase
      .from('discount_codes')
      .insert({ vendor: '', code: '' })
      .select()
      .single();
    if (error) { alert('Error adding code: ' + formatUserError(error)); return; }
    setCodes([...codes, data]);
  };

  const updateCode = async (id, field, value) => {
    const { error } = await supabase
      .from('discount_codes')
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { console.error('Error updating code:', error); return; }
    setCodes(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const deleteCode = async (id) => {
    const { error } = await supabase.from('discount_codes').delete().eq('id', id);
    if (error) { console.error('Error deleting code:', error); return; }
    setCodes(prev => prev.filter(c => c.id !== id));
  };

  if (loading) return <div className="text-gray-600">Loading codes...</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">Discount Codes</h3>
        <button
          onClick={addCode}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
        >
          <Plus size={18} />
          <span>Add Code</span>
        </button>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Vendor</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Code</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Athlete</th>
            <th className="py-3 px-4 w-12"></th>
          </tr>
        </thead>
        <tbody>
          {codes.map(c => (
            <tr key={c.id} className="border-b border-gray-100">
              <td className="py-2 px-4">
                <input
                  type="text"
                  defaultValue={c.vendor}
                  onBlur={(e) => updateCode(c.id, 'vendor', e.target.value)}
                  placeholder="Vendor name"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </td>
              <td className="py-2 px-4">
                <input
                  type="text"
                  defaultValue={c.code}
                  onBlur={(e) => updateCode(c.id, 'code', e.target.value)}
                  placeholder="Discount code"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </td>
              <td className="py-2 px-4">
                <select
                  value={c.player_id || ''}
                  onChange={(e) => updateCode(c.id, 'player_id', e.target.value || null)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                >
                  <option value="">All (global)</option>
                  {players.map(p => (
                    <option key={p.id} value={p.id}>{p.full_name}</option>
                  ))}
                </select>
              </td>
              <td className="py-2 px-4 text-center">
                <button onClick={() => deleteCode(c.id)} className="text-red-400 hover:text-red-600 transition">
                  <Trash2 size={16} />
                </button>
              </td>
            </tr>
          ))}
          {codes.length === 0 && (
            <tr>
              <td colSpan={4} className="py-8 text-center text-gray-500">No codes yet. Click "Add Code" to create one.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ============================================
// INVENTORY TAB
// ============================================

const INVENTORY_CATEGORIES = ['Socks', 'Belts', 'Hats', 'Shorts', 'Shirts', 'Jerseys', 'Sweatshirts', 'Long Sleeve', 'Pants'];

function InventoryTab() {
  const [items, setItems] = useState([]);
  const [threshold, setThreshold] = useState(5);
  const [settingsId, setSettingsId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchInventory(); }, []);

  const fetchInventory = async () => {
    const [{ data: itemData }, { data: settingsData }] = await Promise.all([
      supabase.from('inventory_items').select('*').order('category').order('item').order('color').order('size'),
      supabase.from('inventory_settings').select('*').limit(1).maybeSingle(),
    ]);
    setItems(itemData || []);
    if (settingsData) {
      setThreshold(settingsData.low_stock_threshold);
      setSettingsId(settingsData.id);
    }
    setLoading(false);
  };

  const addRow = async () => {
    const { data, error } = await supabase
      .from('inventory_items')
      .insert({ category: '', item: '', color: '', size: '', qty_in_stock: 0, on_order: 0 })
      .select()
      .single();
    if (error) { alert('Error adding row: ' + formatUserError(error)); return; }
    setItems([...items, data]);
  };

  const updateItem = async (id, field, value) => {
    const isNumber = field === 'qty_in_stock' || field === 'on_order';
    const val = isNumber ? (parseInt(value) || 0) : value;
    const { error } = await supabase
      .from('inventory_items')
      .update({ [field]: val, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { console.error('Error updating item:', error); return; }
    setItems(prev => prev.map(i => i.id === id ? { ...i, [field]: val } : i));
  };

  const deleteItem = async (id) => {
    const { error } = await supabase.from('inventory_items').delete().eq('id', id);
    if (error) { console.error('Error deleting item:', error); return; }
    setItems(prev => prev.filter(i => i.id !== id));
  };

  const updateThreshold = async (value) => {
    const val = parseInt(value) || 0;
    setThreshold(val);
    if (settingsId) {
      await supabase.from('inventory_settings').update({ low_stock_threshold: val }).eq('id', settingsId);
    }
  };

  const getStatus = (qty) => {
    if (qty <= 0) return { label: 'OUT OF STOCK', color: 'bg-red-100 text-red-700' };
    if (qty <= threshold) return { label: 'LOW STOCK', color: 'bg-yellow-100 text-yellow-700' };
    return { label: 'OK', color: 'bg-green-100 text-green-700' };
  };

  // Summary metrics
  const totalSKUs = items.length;
  const totalInStock = items.reduce((sum, i) => sum + (i.qty_in_stock || 0), 0);
  const totalOnOrder = items.reduce((sum, i) => sum + (i.on_order || 0), 0);
  const totalExpected = totalInStock + totalOnOrder;
  const outOfStockCount = items.filter(i => (i.qty_in_stock || 0) <= 0).length;
  const lowStockCount = items.filter(i => (i.qty_in_stock || 0) > 0 && (i.qty_in_stock || 0) <= threshold).length;
  const okCount = items.filter(i => (i.qty_in_stock || 0) > threshold).length;

  // Stock by category
  const categoryStats = {};
  items.forEach(i => {
    const cat = i.category || 'Uncategorized';
    if (!categoryStats[cat]) categoryStats[cat] = { inStock: 0, onOrder: 0 };
    categoryStats[cat].inStock += i.qty_in_stock || 0;
    categoryStats[cat].onOrder += i.on_order || 0;
  });

  if (loading) return <div className="text-gray-600">Loading inventory...</div>;

  return (
    <div className="space-y-6">
      {/* Dashboard Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Key Metrics */}
        <div className="bg-gray-50 rounded-lg p-5">
          <h4 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-3">Key Metrics</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-gray-600">Total SKUs</span><span className="font-semibold text-gray-900">{totalSKUs}</span>
            <span className="text-gray-600">Total Units in Stock</span><span className="font-semibold text-gray-900">{totalInStock}</span>
            <span className="text-gray-600">Total Units On Order</span><span className="font-semibold text-gray-900">{totalOnOrder}</span>
            <span className="text-gray-600">Total Expected Stock</span><span className="font-semibold text-gray-900">{totalExpected}</span>
          </div>
          <div className="mt-4 space-y-1.5">
            <div className="flex items-center space-x-2">
              <span className="inline-block w-3 h-3 rounded bg-red-400"></span>
              <span className="text-sm text-gray-700">Out of Stock: <strong>{outOfStockCount}</strong></span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="inline-block w-3 h-3 rounded bg-yellow-400"></span>
              <span className="text-sm text-gray-700">Low Stock: <strong>{lowStockCount}</strong></span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="inline-block w-3 h-3 rounded bg-green-400"></span>
              <span className="text-sm text-gray-700">OK: <strong>{okCount}</strong></span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-gray-200">
            <label className="block text-xs text-gray-500 mb-1">Low Stock Threshold</label>
            <input
              type="number"
              min="0"
              value={threshold}
              onChange={(e) => updateThreshold(e.target.value)}
              className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Stock by Category */}
        <div className="bg-gray-50 rounded-lg p-5">
          <h4 className="text-sm font-bold text-gray-900 uppercase tracking-wide mb-3">Stock by Category</h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1.5 font-semibold text-gray-700">Category</th>
                <th className="text-right py-1.5 font-semibold text-gray-700">In Stock</th>
                <th className="text-right py-1.5 font-semibold text-gray-700">On Order</th>
                <th className="text-right py-1.5 font-semibold text-gray-700">Expected</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(categoryStats).sort(([a], [b]) => a.localeCompare(b)).map(([cat, stats]) => (
                <tr key={cat} className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-900">{cat}</td>
                  <td className="py-1.5 text-right text-gray-700">{stats.inStock}</td>
                  <td className="py-1.5 text-right text-gray-700">{stats.onOrder}</td>
                  <td className="py-1.5 text-right font-medium text-gray-900">{stats.inStock + stats.onOrder}</td>
                </tr>
              ))}
              {Object.keys(categoryStats).length === 0 && (
                <tr><td colSpan={4} className="py-4 text-center text-gray-500">No data yet</td></tr>
              )}
              {Object.keys(categoryStats).length > 0 && (
                <tr className="font-semibold">
                  <td className="py-1.5 text-gray-900">TOTAL</td>
                  <td className="py-1.5 text-right text-gray-900">{totalInStock}</td>
                  <td className="py-1.5 text-right text-gray-900">{totalOnOrder}</td>
                  <td className="py-1.5 text-right text-gray-900">{totalExpected}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inventory Table */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900">All Items</h3>
          <button
            onClick={addRow}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2"
          >
            <Plus size={18} />
            <span>Add Row</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-3 px-3 text-sm font-semibold text-gray-700">Category</th>
                <th className="text-left py-3 px-3 text-sm font-semibold text-gray-700">Item</th>
                <th className="text-left py-3 px-3 text-sm font-semibold text-gray-700">Color</th>
                <th className="text-left py-3 px-3 text-sm font-semibold text-gray-700">Size</th>
                <th className="text-right py-3 px-3 text-sm font-semibold text-gray-700">Qty in Stock</th>
                <th className="text-right py-3 px-3 text-sm font-semibold text-gray-700">On Order</th>
                <th className="text-right py-3 px-3 text-sm font-semibold text-gray-700">Expected Stock</th>
                <th className="text-center py-3 px-3 text-sm font-semibold text-gray-700">Status</th>
                <th className="py-3 px-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => {
                const expected = (item.qty_in_stock || 0) + (item.on_order || 0);
                const status = getStatus(item.qty_in_stock || 0);
                return (
                  <tr key={item.id} className="border-b border-gray-100">
                    <td className="py-2 px-3">
                      <select
                        defaultValue={item.category}
                        onChange={(e) => updateItem(item.id, 'category', e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
                      >
                        <option value="">Select</option>
                        {INVENTORY_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      <input type="text" defaultValue={item.item} onBlur={(e) => updateItem(item.id, 'item', e.target.value)} placeholder="Item name" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </td>
                    <td className="py-2 px-3">
                      <input type="text" defaultValue={item.color} onBlur={(e) => updateItem(item.id, 'color', e.target.value)} placeholder="Color" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </td>
                    <td className="py-2 px-3">
                      <input type="text" defaultValue={item.size} onBlur={(e) => updateItem(item.id, 'size', e.target.value)} placeholder="Size" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    </td>
                    <td className="py-2 px-3">
                      <input type="number" min="0" defaultValue={item.qty_in_stock} onBlur={(e) => updateItem(item.id, 'qty_in_stock', e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 text-right" />
                    </td>
                    <td className="py-2 px-3">
                      <input type="number" min="0" defaultValue={item.on_order} onBlur={(e) => updateItem(item.id, 'on_order', e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 text-right" />
                    </td>
                    <td className="py-2 px-3 text-right text-sm font-medium text-gray-900">{expected}</td>
                    <td className="py-2 px-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${status.color}`}>{status.label}</span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button onClick={() => deleteItem(item.id)} className="text-red-400 hover:text-red-600 transition">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-gray-500">No inventory items yet. Click "Add Row" to create one.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ============================================
// DOCUMENTS TAB
// ============================================
function DocumentStatusTable({ players, completionMap, docLabel, reminderSubject }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [copyFeedback, setCopyFeedback] = useState(false);

  const filtered = players.filter(p => {
    if (statusFilter === 'signed') return !!completionMap[p.id];
    if (statusFilter === 'unsigned') return !completionMap[p.id];
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const aHas = completionMap[a.id] ? 1 : 0;
    const bHas = completionMap[b.id] ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    return (a.full_name || '').localeCompare(b.full_name || '');
  });

  const signedCount = players.filter(p => completionMap[p.id]).length;
  const unsignedCount = players.length - signedCount;
  const unsignedEmails = players.filter(p => !completionMap[p.id]).map(p => p.email).filter(Boolean);

  const handleCopyEmails = () => {
    navigator.clipboard.writeText(unsignedEmails.join(', '));
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const [emailAllSending, setEmailAllSending] = React.useState(false);

  const handleEmailAll = async () => {
    // CM2: mailto leaked every unsigned email into the browser history +
    // referrer + URL bar. Send through the existing send-email edge function
    // so each recipient gets their own message and the list never leaves
    // server-side.
    const targets = players.filter(p => !completionMap[p.id] && p.email);
    if (targets.length === 0) return;
    const confirmMsg = `Send a ${docLabel} reminder to ${targets.length} ${targets.length === 1 ? 'person' : 'people'}?`;
    if (!window.confirm(confirmMsg)) return;
    setEmailAllSending(true);
    const subject = reminderSubject;
    const body = `Hi {{NAME}},\n\nThis is a reminder to please complete your ${docLabel} at your earliest convenience.\n\nLog in at https://www.thenatural-app.com\n\nThank you!`;
    let ok = 0, failed = 0;
    for (const p of targets) {
      try {
        const personalized = body.replace('{{NAME}}', (p.full_name || '').split(' ')[0] || 'there');
        const { error } = await supabase.functions.invoke('send-email', {
          body: {
            recipientEmail: p.email,
            recipientName: p.full_name || p.email,
            subject,
            body: personalized,
            playerId: p.id,
          },
        });
        if (error) failed++; else ok++;
      } catch { failed++; }
    }
    setEmailAllSending(false);
    alert(`Sent ${ok} of ${targets.length}${failed ? ` (${failed} failed)` : ''}.`);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center space-x-2">
          <span className="text-xs text-gray-500">{signedCount} complete &middot; {unsignedCount} incomplete</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="all">All players</option>
            <option value="signed">Complete</option>
            <option value="unsigned">Incomplete</option>
          </select>
        </div>
      </div>
      {unsignedEmails.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={handleCopyEmails}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition"
          >
            <ClipboardList size={13} />
            <span>{copyFeedback ? 'Copied!' : 'Copy Incomplete Emails'}</span>
          </button>
          <button
            onClick={handleEmailAll}
            disabled={emailAllSending}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-60"
          >
            <Mail size={13} />
            <span>{emailAllSending ? 'Sending…' : 'Email All Incomplete'}</span>
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Player Name</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Email</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Status</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Date</th>
              <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(player => {
              const record = completionMap[player.id];
              return (
                <tr key={player.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 px-4 text-sm text-gray-900 font-medium">{player.full_name}</td>
                  <td className="py-3 px-4 text-sm text-gray-600">{player.email}</td>
                  <td className="py-3 px-4">
                    {record ? (
                      <span className="inline-flex items-center space-x-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                        <CheckCircle size={12} />
                        <span>Complete</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center space-x-1 px-2 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                        <XCircle size={12} />
                        <span>Incomplete</span>
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-600">
                    {record?.signed_at ? new Date(record.signed_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                  </td>
                  <td className="py-3 px-4">
                    {!record && player.email && (
                      <a
                        href={`mailto:${player.email}?subject=${encodeURIComponent(reminderSubject)}&body=${encodeURIComponent(`Hi ${player.full_name || ''},\n\nThis is a reminder to please complete your ${docLabel} at your earliest convenience.\n\nLog in at https://www.thenatural-app.com\n\nThank you!`)}`}
                        className="inline-flex items-center space-x-1 text-xs text-blue-600 hover:text-blue-800"
                      >
                        <Mail size={12} />
                        <span>Remind</span>
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-gray-500">No players found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocumentsTab({ players, waiverSignatures, contractSignatures, medicalHistories }) {
  const [docTab, setDocTab] = useState('waivers');

  const waiverMap = {};
  waiverSignatures.forEach(w => { waiverMap[w.user_id] = w; });

  const contractMap = {};
  contractSignatures.forEach(c => { contractMap[c.user_id] = c; });

  const medicalMap = {};
  medicalHistories.forEach(m => { medicalMap[m.user_id] = m; });

  const waiverCount = players.filter(p => waiverMap[p.id]).length;
  const contractCount = players.filter(p => contractMap[p.id]).length;
  const medicalCount = players.filter(p => medicalMap[p.id]).length;

  const tabs = [
    { key: 'waivers', label: 'Waivers', count: waiverCount },
    { key: 'contracts', label: 'Player Contracts', count: contractCount },
    { key: 'medical', label: 'Medical History', count: medicalCount },
  ];

  return (
    <div>
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Player Document Status</h3>
      <div className="flex space-x-1 mb-4 bg-gray-100 rounded-lg p-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setDocTab(tab.key)}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition ${
              docTab === tab.key ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.label} <span className="text-xs ml-1">({tab.count}/{players.length})</span>
          </button>
        ))}
      </div>

      {docTab === 'waivers' && (
        <DocumentStatusTable players={players} completionMap={waiverMap} docLabel="Waiver" reminderSubject="Reminder: Please Sign Your Waiver" />
      )}
      {docTab === 'contracts' && (
        <DocumentStatusTable players={players} completionMap={contractMap} docLabel="Player Contract" reminderSubject="Reminder: Please Sign Your Player Contract" />
      )}
      {docTab === 'medical' && (
        <DocumentStatusTable players={players} completionMap={medicalMap} docLabel="Medical History / Athlete Intake Form" reminderSubject="Reminder: Please Complete Your Medical History Form" />
      )}
    </div>
  );
}

// ============================================
// COACH TASKS TAB
// ============================================

function CoachTasksTab({ coaches, userId }) {
  const [tasks, setTasks] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCoach, setFilterCoach] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterFrequency, setFilterFrequency] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  // #469: last successful notification per task / per coach's daily digest,
  // and a small inline note about the most recent on-assign send.
  const [notified, setNotified] = useState({ byTask: {}, byCoachDaily: {} });
  const [notifyNote, setNotifyNote] = useState(null);

  const fetchTasks = async () => {
    const { data, error } = await supabase
      .from('coach_tasks')
      .select('*, assigned_coach:assigned_to(id, full_name, avatar_url), assigner:assigned_by(full_name)')
      .order('created_at', { ascending: false });
    if (error) console.error('Error fetching coach tasks:', error);
    else setTasks(data || []);
    setNotified(await fetchLastNotified());
  };

  // Fire-and-forget after the task is saved: the modal has already closed,
  // a failure only leaves a note above the list.
  const notifyAssigned = async (taskIds) => {
    if (!taskIds?.length) return;
    setNotifyNote({ tone: 'info', text: 'Notifying coach…' });
    const r = await notifyTasksAssigned(taskIds);
    if (!r.ok) {
      setNotifyNote({ tone: 'error', text: `Task saved, but the notification didn't send: ${r.error || 'unknown error'}` });
    } else if (r.sent > 0) {
      setNotifyNote({ tone: 'ok', text: `Notification sent (${r.sent} message${r.sent === 1 ? '' : 's'}).` });
    } else {
      setNotifyNote({ tone: 'info', text: 'Task saved. No notification went out (no email on file, or already notified).' });
    }
    setNotified(await fetchLastNotified());
  };

  useEffect(() => { fetchTasks(); }, []);

  const handleDelete = async (taskId) => {
    if (!window.confirm('Delete this task?')) return;
    const { error } = await supabase.from('coach_tasks').delete().eq('id', taskId);
    if (error) alert('Error deleting task: ' + formatUserError(error));
    else fetchTasks();
  };

  const todayStr = new Date().toISOString().split('T')[0];
  const isOverdue = (task) => task.due_date && task.due_date < todayStr && task.status !== 'completed';

  const filtered = tasks.filter(t => {
    if (filterCoach !== 'all' && t.assigned_to !== filterCoach) return false;
    if (filterStatus === 'overdue' && !isOverdue(t)) return false;
    if (filterStatus !== 'all' && filterStatus !== 'overdue' && t.status !== filterStatus) return false;
    if (filterFrequency !== 'all' && t.frequency !== filterFrequency) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const hay = [t.title, t.description, t.assigned_coach?.full_name].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const counts = { pending: 0, in_progress: 0, completed: 0, overdue: 0 };
  tasks.forEach(t => {
    counts[t.status]++;
    if (isOverdue(t)) counts.overdue++;
  });

  const priorityColors = { low: 'bg-gray-100 text-gray-700', medium: 'bg-blue-100 text-blue-700', high: 'bg-orange-100 text-orange-700', urgent: 'bg-red-100 text-red-700' };
  const statusColors = { pending: 'bg-yellow-100 text-yellow-700', in_progress: 'bg-blue-100 text-blue-700', completed: 'bg-green-100 text-green-700' };
  const frequencyColors = { daily: 'bg-purple-100 text-purple-700', weekly: 'bg-indigo-100 text-indigo-700', monthly: 'bg-teal-100 text-teal-700', 'one-time': 'bg-gray-100 text-gray-700' };
  const statusLabels = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-gray-900">Coach Task Assignments</h3>
        <button onClick={() => setShowCreateModal(true)} className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition flex items-center space-x-2">
          <Plus size={18} /><span>Assign Task</span>
        </button>
      </div>

      {/* Summary counts */}
      <div className="flex flex-wrap gap-3">
        <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-700">Pending: {counts.pending}</span>
        <span className="px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-700">In Progress: {counts.in_progress}</span>
        <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-700">Completed: {counts.completed}</span>
        {counts.overdue > 0 && <span className="px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-700">Overdue: {counts.overdue}</span>}
      </div>

      <p className="text-xs text-gray-500">Coaches are emailed each task when it's assigned, plus a 7am digest of today's daily, due and overdue tasks.</p>
      {notifyNote && (
        <div className={`flex items-start justify-between gap-3 px-3 py-2 rounded-lg text-sm ${notifyNote.tone === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : notifyNote.tone === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-50 text-gray-600 border border-gray-200'}`}>
          <span>{notifyNote.text}</span>
          <button onClick={() => setNotifyNote(null)} className="shrink-0 opacity-70 hover:opacity-100"><X size={14} /></button>
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-lg p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search tasks..." className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <select value={filterCoach} onChange={e => setFilterCoach(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="all">All Coaches</option>
          {coaches.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="overdue">Overdue</option>
        </select>
        <select value={filterFrequency} onChange={e => setFilterFrequency(e.target.value)} className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          <option value="all">All Frequencies</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="one-time">One-time</option>
        </select>
      </div>

      {/* Task cards */}
      {filtered.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No tasks found.</p>
      ) : (
        <div className="grid gap-3">
          {filtered.map(task => (
            <div key={task.id} className={`border rounded-lg p-4 ${isOverdue(task) ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-semibold text-gray-900">{task.title}</h4>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[task.status]}`}>{statusLabels[task.status]}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${priorityColors[task.priority]}`}>{task.priority}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${frequencyColors[task.frequency]}`}>{task.frequency}</span>
                    {isOverdue(task) && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Overdue</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                    <span>Assigned to: <strong>{task.assigned_coach?.full_name}</strong></span>
                    {task.due_date && <span className="flex items-center gap-1"><Calendar size={14} /> Due: {task.due_date}</span>}
                  </div>
                  {task.description && <p className="text-sm text-gray-600 mt-1 line-clamp-2">{task.description}</p>}
                  {(notified.byTask[task.id] || (task.status !== 'completed' && notified.byCoachDaily[task.assigned_to])) && (
                    <p className="flex items-center gap-1 mt-1 text-xs text-gray-400">
                      <Mail size={12} />
                      {notified.byTask[task.id] && <span>Notified {formatNotifiedAt(notified.byTask[task.id].sent_at)} ({notified.byTask[task.id].channel})</span>}
                      {notified.byTask[task.id] && task.status !== 'completed' && notified.byCoachDaily[task.assigned_to] && <span>·</span>}
                      {task.status !== 'completed' && notified.byCoachDaily[task.assigned_to] && <span>Coach's last digest {formatNotifiedAt(notified.byCoachDaily[task.assigned_to].sent_at)}</span>}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <button onClick={() => setEditingTask(task)} className="text-blue-600 hover:text-blue-800"><Edit2 size={16} /></button>
                  <button onClick={() => handleDelete(task.id)} className="text-red-600 hover:text-red-800"><Trash2 size={16} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateModal && <CreateTaskModal coaches={coaches} userId={userId} onClose={() => setShowCreateModal(false)} onSuccess={(newIds) => { setShowCreateModal(false); fetchTasks(); notifyAssigned(newIds); }} />}
      {editingTask && <EditTaskModal task={editingTask} coaches={coaches} onClose={() => setEditingTask(null)} onSuccess={(reassignedId) => { setEditingTask(null); fetchTasks(); if (reassignedId) notifyAssigned([reassignedId]); }} />}
    </div>
  );
}

function CreateTaskModal({ coaches, userId, onClose, onSuccess }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedCoaches, setSelectedCoaches] = useState([]);
  const [frequency, setFrequency] = useState('one-time');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleCoach = (id) => {
    setSelectedCoaches(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || selectedCoaches.length === 0) return alert('Title and at least one coach are required.');
    setSaving(true);
    const rows = selectedCoaches.map(coachId => ({
      title: title.trim(),
      description: description.trim() || null,
      assigned_to: coachId,
      assigned_by: userId,
      frequency,
      priority,
      due_date: dueDate || null,
      status: 'pending',
    }));
    const { data: created, error } = await supabase.from('coach_tasks').insert(rows).select('id');
    setSaving(false);
    if (error) alert('Error creating task: ' + formatUserError(error));
    else onSuccess((created || []).map(r => r.id));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">Assign Task</h3>
          <button onClick={onClose}><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} required className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assign to Coaches *</label>
            <div className="border border-gray-300 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">
              {coaches.map(c => (
                <label key={c.id} className="flex items-center gap-2 px-2 py-1 hover:bg-gray-50 rounded cursor-pointer">
                  <input type="checkbox" checked={selectedCoaches.includes(c.id)} onChange={() => toggleCoach(c.id)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                  <span className="text-sm">{c.full_name}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Frequency</label>
              <select value={frequency} onChange={e => setFrequency(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="one-time">One-time</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">{saving ? 'Saving...' : 'Assign Task'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditTaskModal({ task, coaches, onClose, onSuccess }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [assignedTo, setAssignedTo] = useState(task.assigned_to);
  const [frequency, setFrequency] = useState(task.frequency);
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [dueDate, setDueDate] = useState(task.due_date || '');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const updates = {
      title: title.trim(),
      description: description.trim() || null,
      assigned_to: assignedTo,
      frequency,
      priority,
      status,
      due_date: dueDate || null,
      updated_at: new Date().toISOString(),
    };
    if (status === 'completed' && task.status !== 'completed') {
      updates.completed_at = new Date().toISOString();
    } else if (status !== 'completed') {
      updates.completed_at = null;
    }
    const { error } = await supabase.from('coach_tasks').update(updates).eq('id', task.id);
    setSaving(false);
    if (error) alert('Error updating task: ' + formatUserError(error));
    // #469: a reassigned task is announced to its new coach.
    else onSuccess(assignedTo !== task.assigned_to && status !== 'completed' ? task.id : null);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">Edit Task</h3>
          <button onClick={onClose}><X size={20} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} required className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assigned to</label>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
              {coaches.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Frequency</label>
              <select value={frequency} onChange={e => setFrequency(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="one-time">One-time</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select value={priority} onChange={e => setPriority(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================
// DUPLICATES TAB
// ============================================

function DuplicatesTab({ users, refreshUsers, onNavigateToProfile }) {
  const groups = React.useMemo(() => {
    const map = {};
    users.forEach(u => {
      const key = (u.full_name || '').trim().toLowerCase();
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(u);
    });
    return Object.entries(map)
      .filter(([, arr]) => arr.length > 1)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [users]);

  const handleArchive = async (userId) => {
    if (!window.confirm('Archive this user? Their status will be set to Archived.')) return;
    const profile = users.find(u => u.id === userId)?.player_profiles;
    const profileId = Array.isArray(profile) ? profile[0]?.id : profile?.id;
    // Archived status lives on the athlete profile. This tab lists duplicates
    // of every role, so a duplicate coach or staff account has nothing to
    // archive — say so instead of doing nothing and looking successful.
    if (!profileId) {
      alert('This account has no athlete profile, so there is nothing to archive. Use Delete to remove the duplicate account.');
      return;
    }
    const { error } = await supabase.from('player_profiles').update({ status: 'Archived' }).eq('id', profileId);
    if (error) { alert('Archive failed: ' + formatUserError(error)); return; }
    refreshUsers();
  };

  const handleDelete = async (userId) => {
    if (!window.confirm('Permanently delete this user account? This cannot be undone.')) return;
    try {
      await deleteAuthUser(userId);
      refreshUsers();
    } catch (err) {
      alert('Delete failed: ' + formatUserError(err));
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Duplicate Accounts</h3>
        <p className="text-sm text-gray-500 mt-1">Users with the same name. Review and archive or delete duplicates.</p>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Users size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm">No duplicate accounts detected.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={16} />
            {groups.length} group{groups.length === 1 ? '' : 's'} of potential duplicates found ({groups.reduce((s, [, a]) => s + a.length, 0)} accounts total)
          </p>
          {groups.map(([key, dupes]) => (
            <div key={key} className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                <span className="font-semibold text-gray-900 capitalize">{key}</span>
                <span className="text-gray-500 text-sm ml-2">({dupes.length} accounts)</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 px-4 text-xs font-semibold text-gray-500">Name</th>
                    <th className="text-left py-2 px-4 text-xs font-semibold text-gray-500">Email</th>
                    <th className="text-left py-2 px-4 text-xs font-semibold text-gray-500">Role</th>
                    <th className="text-left py-2 px-4 text-xs font-semibold text-gray-500">Status</th>
                    <th className="text-left py-2 px-4 text-xs font-semibold text-gray-500">Created</th>
                    <th className="py-2 px-4 text-xs font-semibold text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {dupes.map(u => {
                    const profile = Array.isArray(u.player_profiles) ? u.player_profiles[0] : u.player_profiles;
                    const status = profile?.status || '—';
                    return (
                      <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-2 px-4">
                          <button
                            onClick={() => onNavigateToProfile && onNavigateToProfile(u.id)}
                            className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                          >
                            {u.full_name}
                          </button>
                        </td>
                        <td className="py-2 px-4 text-gray-600">{u.email || '—'}</td>
                        <td className="py-2 px-4">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            u.role === 'admin' ? 'bg-red-100 text-red-700' :
                            u.role === 'coach' ? 'bg-blue-100 text-blue-700' :
                            'bg-green-100 text-green-700'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-2 px-4 text-gray-600 text-xs">{status}</td>
                        <td className="py-2 px-4 text-gray-500 text-xs">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                        <td className="py-2 px-4 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={() => handleArchive(u.id)}
                              className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-100 text-gray-600"
                              title="Archive this account"
                            >
                              Archive
                            </button>
                            <button
                              onClick={() => handleDelete(u.id)}
                              className="text-xs px-2 py-1 border border-red-300 rounded hover:bg-red-50 text-red-600"
                              title="Delete this account"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
