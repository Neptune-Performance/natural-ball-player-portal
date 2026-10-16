import React, { useState, useEffect, useRef } from 'react';
import { supabase, supabaseUrl, supabaseAnonKey } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { buildSlotExceptionMap, getSlotDateException } from './scheduleUtils';
import AdminSettings from './AdminSettings';
import PlayerDashboard from './PlayerDashboard';
import CoachTools from './CoachTools';
import Programming from './Programming';
import Profile from './Profile';
import Schedule from './Schedule';
import Messages from './Messages';
import EmailCampaigns from './EmailCampaigns';
import MyTeam from './MyTeam';
import TrainingGroups from './TrainingGroups';
import KnowledgeBase from './KnowledgeBase';
import Fields from './Fields';
import ManageAthletes from './ManageAthletes';
import ManageCoaches from './ManageCoaches';
import WaiverPage from './WaiverPage';
import ContractPage from './ContractPage';
import FacilityFinePage from './FacilityFinePage';
import NbpPlusAgreementPage from './NbpPlusAgreementPage';
import { isNbpPlusMember, fetchAgreementSigned } from './nbpPlusAgreement';
import LetterOfIntentPage from './LetterOfIntentPage';
import WorkPortalShell from './WorkPortal';
import PublicBookingPage from './PublicBookingPage';
import UnsubscribePage from './UnsubscribePage';
import PublicPortal from './PublicPortal';
import NotificationBell, { deletePendingPayment, dismissEventAssignment } from './NotificationBell';
import { formatUserError } from './errorMessage';
import { initUsage, setUsageContext, trackView, trackViewExit } from './usage';
import { useMainPortalCounts, useWorkPortalCounts, useWhoopNudge, dismissPtVisitNotice, markAllPtVisitNoticesSeen, dismissWeeklyReminder, dismissWhoopNudge } from './useNotifications';
import { Users, Calendar, BarChart3, BookOpen, MessageSquare, Settings, TrendingUp, Activity, Target, Wrench, Bell, Clock, UserCog, FileText, FolderOpen, ChevronDown, ChevronRight, Briefcase, Mail, Lock, ArrowLeft, Menu, X, MapPin, AlertCircle, CheckCircle, Layers, Dumbbell } from 'lucide-react';
import './App.css';

const fmtLocalDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// #382: age in whole years from a 'YYYY-MM-DD' DOB. Kept byte-identical to the
// copies in Profile.js, AutoProgram.js, HittingGenerator.js, NutritionGenerator.js
// and ProgramGenerator.js rather than introducing a second, subtly different age
// check. NOTE: WaiverPage.js does NOT derive minor status from DOB — its
// `is_minor` is a checkbox the signer ticks — so there was no shared rule to import.
const ageFromDob = (dob) => {
  if (!dob) return null;
  const age = Math.floor((new Date() - new Date(dob + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000));
  return Number.isFinite(age) ? age : null;
};

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState(null);
  const [secondaryRole, setSecondaryRole] = useState(null);
  const [userId, setUserId] = useState(null);
  const [currentView, setCurrentView] = useState(() => {
    // #438: the weekly reminder email deep-links with ?view=stats (profile,
    // Stats tab — MainApp's profileInitialTab reads the same param) or
    // ?view=messages. Consumed once: the param is stripped so a refresh goes
    // back to the remembered view.
    try {
      const p = new URLSearchParams(window.location.search);
      const v = p.get('view');
      if (v === 'stats' || v === 'messages') {
        if (v === 'stats') { try { sessionStorage.setItem('nbp_deeplink_tab', 'stats'); } catch {} }
        p.delete('view');
        const qs = p.toString();
        window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash || ''}`);
        return v === 'stats' ? 'profile' : 'messages';
      }
    } catch {}
    try { return localStorage.getItem('nbp_current_view') || ''; } catch { return ''; }
  });
  const [workPortalView, setWorkPortalView] = useState(() => {
    try { return localStorage.getItem('nbp_work_view') || 'work-home'; } catch { return 'work-home'; }
  });
  const [waiverSigned, setWaiverSigned] = useState(null);
  const [contractSigned, setContractSigned] = useState(null);
  const [loiSigned, setLoiSigned] = useState(null);
  const [facilityFineSigned, setFacilityFineSigned] = useState(null);
  // #440: NBP+ Training Agreement. null = not an NBP+ athlete / unknown (no
  // dot, no page in the sidebar); false = training-group member who hasn't
  // signed the current document; true = signed.
  const [nbpPlusAgreementSigned, setNbpPlusAgreementSigned] = useState(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [currentPortal, setCurrentPortal] = useState(() => {
    try {
      return localStorage.getItem('nbp_current_portal') || 'main';
    } catch {
      return 'main';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('nbp_current_portal', currentPortal);
    } catch {}
  }, [currentPortal]);

  useEffect(() => {
    if (!currentView) return;
    try { localStorage.setItem('nbp_current_view', currentView); } catch {}
  }, [currentView]);

  useEffect(() => {
    if (!userRole) return;
    const defaultView = userRole === 'player' ? 'dashboard' : 'schedule';
    if (!currentView) { setCurrentView(defaultView); return; }
    // A persisted view (localStorage) may be invalid for the current role — e.g. a
    // player landing on manage-athletes/settings, or a coach on a usage/manage-coaches
    // view. Those render blocks fail their gates and show a blank page with no
    // redirect, so reset to the role's default instead.
    const adminOnly = ['manage-coaches', 'manage-interns'];
    // 'profile-view' is the "someone else's profile" screen. Athletes have no
    // legitimate route into it (their own profile is 'profile'), and it is
    // persisted to localStorage, so a stale value must not survive a reload.
    const staffOnly = ['training-groups', 'manage-athletes', 'coach-tools', 'programming', 'settings', 'profile-view'];
    const forbidden =
      (userRole !== 'admin' && adminOnly.includes(currentView)) ||
      (userRole === 'player' && staffOnly.includes(currentView));
    if (forbidden) setCurrentView(defaultView);
  }, [userRole, currentView]);

  // V2 research experiment: anonymous usage tracking, gated on
  // REACT_APP_USAGE_TRACKING=1. No PII collected — see src/usage.js.
  useEffect(() => {
    if (!userRole) return;
    initUsage({ role: userRole, secondary_role: secondaryRole, portal: currentPortal });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userRole]);

  useEffect(() => {
    if (!userRole) return;
    setUsageContext({ secondary_role: secondaryRole, portal: currentPortal });
  }, [userRole, secondaryRole, currentPortal]);

  const prevTrackedViewRef = useRef(null);
  useEffect(() => {
    if (!userRole) return;
    const activeView = currentPortal === 'work' ? workPortalView : currentView;
    if (!activeView) return;
    if (prevTrackedViewRef.current && prevTrackedViewRef.current !== activeView) {
      trackViewExit(prevTrackedViewRef.current);
    }
    if (prevTrackedViewRef.current !== activeView) {
      trackView(activeView, { portal: currentPortal });
      prevTrackedViewRef.current = activeView;
    }
  }, [currentView, workPortalView, currentPortal, userRole]);

  useEffect(() => {
    try { localStorage.setItem('nbp_work_view', workPortalView); } catch {}
  }, [workPortalView]);

  useEffect(() => {
    if (userRole === 'player' && currentPortal === 'work') {
      setCurrentPortal('main');
    }
  }, [userRole, currentPortal]);

  const checkWaiverStatus = async (uid) => {
    const { data } = await supabase
      .from('waiver_signatures')
      .select('id')
      .eq('user_id', uid)
      .maybeSingle();
    setWaiverSigned(!!data);
  };

  const checkContractStatus = async (uid) => {
    const { data } = await supabase
      .from('player_contracts')
      .select('id')
      .eq('user_id', uid)
      .maybeSingle();
    setContractSigned(!!data);
  };

  const checkLoiStatus = async (uid) => {
    const { data } = await supabase
      .from('player_letters_of_intent')
      .select('id')
      .eq('user_id', uid)
      .maybeSingle();
    setLoiSigned(!!data);
  };

  const checkFacilityFineStatus = async (uid) => {
    // Find the most recent uploaded "Facility Fine" document. If none exists,
    // mark as signed (nothing to nag about). If it exists, check whether this
    // user has signed THIS document — re-uploading a new version of the doc
    // resets the prompt for everyone.
    const { data: docRows } = await supabase
      .from('staff_documents')
      .select('id')
      .ilike('title', 'Facility Fine%')
      .order('created_at', { ascending: false })
      .limit(1);
    const doc = docRows && docRows[0];
    // #378: "I can't see a document" is NOT evidence that the user signed one.
    // Athletes could never read staff_documents, so this branch quietly marked
    // all ~1,000 of them as signed and suppressed the reminder dot — which is
    // why only 3 facility fine signatures exist against 210 waivers. Report
    // null (unknown) instead: the sidebar tests `=== false`, so null shows no
    // dot but also makes no false claim. Do not restore `true` here.
    if (!doc) { setFacilityFineSigned(null); return; }
    const { data } = await supabase
      .from('facility_fine_signatures')
      .select('id')
      .eq('user_id', uid)
      .eq('document_id', doc.id)
      .maybeSingle();
    setFacilityFineSigned(!!data);
  };

  // #440: only training-group members (NBP+ athletes) are asked to sign.
  // Everyone else stays null so the sidebar never shows the item.
  const checkNbpPlusAgreementStatus = async (uid) => {
    const member = await isNbpPlusMember(uid);
    if (!member) { setNbpPlusAgreementSigned(null); return; }
    setNbpPlusAgreementSigned(await fetchAgreementSigned(uid));
  };

  useEffect(() => {
    const hash = window.location.hash || '';
    const search = window.location.search || '';
    const isRecoveryUrl = hash.includes('type=recovery') || search.includes('type=recovery');
    if (isRecoveryUrl) {
      setPasswordRecovery(true);
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordRecovery(true);
      }
      if (session) {
        setUserId(session.user.id);
        fetchUserRole(session.user.id);
        checkWaiverStatus(session.user.id);
        checkContractStatus(session.user.id);
        checkLoiStatus(session.user.id);
        checkFacilityFineStatus(session.user.id);
        checkNbpPlusAgreementStatus(session.user.id);
      } else {
        setUserRole(null);
        setUserId(null);
        setWaiverSigned(null);
        setContractSigned(null);
        setLoiSigned(null);
        setFacilityFineSigned(null);
        setNbpPlusAgreementSigned(null);
      }
      setLoading(false);
    });

    // Fallback: if no auth event fires within 2s (e.g. no session at all), stop loading
    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          supabase.auth.getSession().then(({ data: { session } }) => {
            if (session) {
              setSession(session);
              setUserId(session.user.id);
              fetchUserRole(session.user.id);
              checkWaiverStatus(session.user.id);
              checkContractStatus(session.user.id);
              checkLoiStatus(session.user.id);
              checkFacilityFineStatus(session.user.id);
              checkNbpPlusAgreementStatus(session.user.id);
            }
          }).catch((e) => console.error('auth fallback getSession failed:', e));
        }
        return false;
      });
    }, 2000);

    return () => { subscription.unsubscribe(); clearTimeout(timeout); };
  }, []);

  const [userName, setUserName] = useState('');
  const [userAvatar, setUserAvatar] = useState(null);

  const fetchUserRole = async (userId) => {
    const { data, error } = await supabase
      .from('users')
      .select('role, secondary_role, full_name, email, avatar_url')
      .eq('id', userId)
      .single();

    const applyUserRow = (row) => {
      setUserRole(row.role);
      setSecondaryRole(row.secondary_role || null);
      // Prefer freshly-fetched full_name; fall back to existing state, then auth
      // metadata, then email, so we never replace a good name with "User".
      setUserName((prev) => {
        const fetched = (row.full_name || '').trim();
        if (fetched) return fetched;
        if (prev && prev.trim()) return prev;
        const meta = row.email || '';
        return meta;
      });
      if (row.avatar_url !== undefined) setUserAvatar(row.avatar_url || null);
    };

    if (error) {
      console.error('Error fetching user role:', error);
      // Session may be stale — try refreshing and retrying once
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
      if (!refreshError && refreshData?.session) {
        const { data: retryData, error: retryError } = await supabase
          .from('users')
          .select('role, secondary_role, full_name, email, avatar_url')
          .eq('id', userId)
          .single();
        if (!retryError && retryData) {
          applyUserRow(retryData);
          return;
        }
      } else if (refreshError) {
        // Refresh token is dead (Dom Giustino's case in #180 — a stale session
        // from weeks ago kept "User" in the sidebar for 3s before the SDK gave
        // up). Force a clean sign-out so the next mount shows the login screen
        // instead of a half-loaded shell. The refresh-token failure is the
        // signal that this is NOT a transient fetch error.
        console.warn('Auth refresh failed; signing out stale session.');
        await supabase.auth.signOut();
      }
      // Don't auto sign-out on a transient fetch failure with a still-valid
      // refresh token — that would log the user out mid-session and is the
      // root of issue #164's "logs in then says User" flicker.
    } else {
      applyUserRow(data);
    }
  };

  const handleLogin = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      alert('Error logging in: ' + formatUserError(error));
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    try {
      localStorage.removeItem('nbp_current_view');
      localStorage.removeItem('nbp_work_view');
    } catch {}
    setCurrentView('dashboard');
    setWorkPortalView('work-home');
  };

  // Public, unauthenticated booking route (#229). Rendered before the auth /
  // loading gates so outside customers reach /book without ever seeing login.
  if (window.location.pathname.startsWith('/book')) {
    return <PublicBookingPage />;
  }

  // Public, unauthenticated unsubscribe route (#281). Same placement and for
  // the same reason: this is opened from a link in an email by a parent who
  // is not logged in and never will be. An unsubscribe that asks you to sign
  // in is not an unsubscribe.
  if (window.location.pathname.startsWith('/unsubscribe')) {
    return <UnsubscribePage />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">âš¾</div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // #194: render the reset form whenever passwordRecovery is true, even if
  // the session hasn't been established yet. The previous `&& session` gate
  // meant a recovery URL with a still-pending token exchange would fall
  // through to LoginPage, which looked like the link was broken. The reset
  // page now shows a "Verifying..." state until the session lands, then
  // unlocks the form.
  if (passwordRecovery) {
    return <ResetPasswordPage session={session} onComplete={() => setPasswordRecovery(false)} />;
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />;
  }

  // Public (booking-only) users get a stripped-down mini portal — never the
  // player/staff shell. Wait for the role to resolve so we don't flash MainApp.
  if (userRole === 'public') {
    return <PublicPortal userId={userId} userName={userName} onLogout={handleLogout} />;
  }

  return (
    <div className="bg-gray-100 min-h-screen">
      <MainApp
        userRole={userRole}
        secondaryRole={secondaryRole}
        userId={userId}
        userName={userName}
        userAvatar={userAvatar}
        onLogout={handleLogout}
        currentView={currentView}
        setCurrentView={setCurrentView}
        workPortalView={workPortalView}
        setWorkPortalView={setWorkPortalView}
        waiverSigned={waiverSigned}
        setWaiverSigned={setWaiverSigned}
        contractSigned={contractSigned}
        setContractSigned={setContractSigned}
        loiSigned={loiSigned}
        setLoiSigned={setLoiSigned}
        facilityFineSigned={facilityFineSigned}
        setFacilityFineSigned={setFacilityFineSigned}
        nbpPlusAgreementSigned={nbpPlusAgreementSigned}
        setNbpPlusAgreementSigned={setNbpPlusAgreementSigned}
        currentPortal={currentPortal}
        setCurrentPortal={setCurrentPortal}
      />
    </div>
  );
}

function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [showSignup, setShowSignup] = useState(false);
  const [signup, setSignup] = useState({ full_name: '', email: '', phone: '', password: '', date_of_birth: '', signup_intent: '', parent1_email: '', account_type: 'player' });
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupSent, setSignupSent] = useState(false);
  const [signupError, setSignupError] = useState('');

  // The /book welcome popup's "Create an account" links here with ?signup=public
  // to open the signup form pre-set to a booking-only Public account.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('signup') === 'public') {
      setShowSignup(true);
      setSignup((s) => ({ ...s, account_type: 'public' }));
    }
  }, []);

  const isPublicSignup = signup.account_type === 'public';

  // #382: a parent/guardian email is required for athletes under 18 and offered
  // as optional for 18+. Public (booking-only) accounts are never asked. DOB is
  // itself `required` for the athlete path, so by the time the form can submit
  // this age is always known; a blank DOB simply leaves the field optional.
  const signupAge = ageFromDob(signup.date_of_birth);
  const parentEmailRequired = !isPublicSignup && signupAge !== null && signupAge < 18;
  // Warn (don't block) when the parent address is just the athlete's own address.
  const parentEmailSameAsAthlete =
    !isPublicSignup &&
    !!signup.parent1_email.trim() &&
    signup.parent1_email.trim().toLowerCase() === signup.email.trim().toLowerCase();

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(email, password);
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    setSignupError('');
    setSignupLoading(true);
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
        body: JSON.stringify(signup),
      });
      const result = await res.json();
      if (!res.ok || result.error) throw new Error(result.error || 'Could not create account.');
      setSignupSent(true);
    } catch (err) {
      setSignupError(err.message);
    } finally {
      setSignupLoading(false);
    }
  };

  const resetSignup = () => {
    setShowSignup(false);
    setSignupSent(false);
    setSignupError('');
    setSignup({ full_name: '', email: '', phone: '', password: '', date_of_birth: '', signup_intent: '', parent1_email: '', account_type: 'player' });
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setForgotLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
      redirectTo: `${window.location.origin}/?type=recovery`,
    });
    setForgotLoading(false);
    if (error) {
      alert('Error: ' + formatUserError(error));
    } else {
      setForgotSent(true);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-8">
          <img src="/naturals-diamond.png" alt="The Naturals" className="w-24 h-24 mx-auto mb-4 object-contain" />
          <h1 className="text-3xl font-bold text-gray-900">Natural Ball Player</h1>
          <p className="text-gray-600 mt-2">Magnus Training Platform</p>
        </div>

        {showSignup ? (
          signupSent ? (
            <div className="text-center space-y-4">
              <Mail size={40} className="mx-auto text-blue-500" />
              <h2 className="text-lg font-semibold text-gray-900">Almost there!</h2>
              <p className="text-sm text-gray-600">We sent a confirmation link to <strong>{signup.email}</strong>. Click it to activate your account, then sign in.</p>
              <button
                onClick={resetSignup}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition"
              >
                Back to Sign In
              </button>
            </div>
          ) : (
            <form onSubmit={handleSignup} className="space-y-4">
              <button
                type="button"
                onClick={resetSignup}
                className="flex items-center space-x-1 text-sm text-blue-600 hover:text-blue-800"
              >
                <ArrowLeft size={16} />
                <span>Back to Sign In</span>
              </button>
              <h2 className="text-lg font-semibold text-gray-900">Create Account</h2>
              <p className="text-sm text-gray-600">
                {isPublicSignup
                  ? 'Create a booking account to reserve and pay for sessions at our facility.'
                  : 'New to NBP? Create your athlete account. A coach will get you set up after you confirm your email.'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'player', label: 'Athlete', desc: 'Join / train with NBP' },
                  { value: 'public', label: 'Just Booking', desc: 'Book & pay for sessions' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSignup(s => ({ ...s, account_type: opt.value }))}
                    className={`text-left border rounded-lg px-3 py-2 transition ${
                      signup.account_type === opt.value ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <span className="block text-sm font-medium text-gray-900">{opt.label}</span>
                    <span className="block text-xs text-gray-500">{opt.desc}</span>
                  </button>
                ))}
              </div>
              {signupError && <p className="text-sm text-red-600">{signupError}</p>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Full Name</label>
                <input
                  type="text"
                  value={signup.full_name}
                  onChange={(e) => setSignup(s => ({ ...s, full_name: e.target.value }))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={signup.email}
                  onChange={(e) => setSignup(s => ({ ...s, email: e.target.value }))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Phone <span className="text-gray-400 font-normal">(optional)</span></label>
                <input
                  type="tel"
                  value={signup.phone}
                  onChange={(e) => setSignup(s => ({ ...s, phone: e.target.value }))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {!isPublicSignup && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Date of Birth</label>
                <input
                  type="date"
                  value={signup.date_of_birth}
                  onChange={(e) => setSignup(s => ({ ...s, date_of_birth: e.target.value }))}
                  max={new Date().toISOString().split('T')[0]}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required={!isPublicSignup}
                />
                <p className="text-xs text-gray-400 mt-1">Used to place you in the right age group.</p>
              </div>
              )}
              {!isPublicSignup && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Parent / Guardian Email {!parentEmailRequired && <span className="text-gray-400 font-normal">(optional)</span>}
                </label>
                <input
                  type="email"
                  value={signup.parent1_email}
                  onChange={(e) => setSignup(s => ({ ...s, parent1_email: e.target.value }))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required={parentEmailRequired}
                />
                <p className="text-xs text-gray-400 mt-1">
                  {parentEmailRequired
                    ? 'Required for athletes under 18 so we can reach a parent or guardian.'
                    : 'So we can reach a parent or guardian about schedules, billing and team news.'}
                </p>
                {parentEmailSameAsAthlete && (
                  <p className="text-xs text-amber-600 mt-1">
                    That's the same address as the athlete's. If a parent has their own email, use it here.
                  </p>
                )}
              </div>
              )}
              {!isPublicSignup && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">What are you looking for?</label>
                <div className="grid grid-cols-1 gap-2">
                  {[
                    { value: 'team', label: 'Naturals Team', desc: 'I want to play on a Naturals team' },
                    { value: 'training', label: 'Just Training', desc: 'Training only, no team' },
                    { value: 'both', label: 'Both', desc: 'Naturals team and training' },
                  ].map(opt => (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-3 border rounded-lg px-3 py-2 cursor-pointer transition ${
                        signup.signup_intent === opt.value ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="signup_intent"
                        value={opt.value}
                        checked={signup.signup_intent === opt.value}
                        onChange={(e) => setSignup(s => ({ ...s, signup_intent: e.target.value }))}
                        className="mt-1 text-blue-600 focus:ring-blue-500"
                        required={!isPublicSignup}
                      />
                      <span>
                        <span className="block text-sm font-medium text-gray-900">{opt.label}</span>
                        <span className="block text-xs text-gray-500">{opt.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                <input
                  type="password"
                  value={signup.password}
                  onChange={(e) => setSignup(s => ({ ...s, password: e.target.value }))}
                  minLength={12}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
                <p className="text-xs text-gray-400 mt-1">At least 12 characters.</p>
              </div>
              <button
                type="submit"
                disabled={signupLoading}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {signupLoading ? 'Creating...' : 'Create Account'}
              </button>
            </form>
          )
        ) : showForgot ? (
          forgotSent ? (
            <div className="text-center space-y-4">
              <Mail size={40} className="mx-auto text-blue-500" />
              <h2 className="text-lg font-semibold text-gray-900">Check Your Email</h2>
              <p className="text-sm text-gray-600">We sent a password reset link to <strong>{forgotEmail}</strong>. Click the link in the email to reset your password.</p>
              <button
                onClick={() => { setShowForgot(false); setForgotSent(false); setForgotEmail(''); }}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition"
              >
                Back to Sign In
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <button
                type="button"
                onClick={() => setShowForgot(false)}
                className="flex items-center space-x-1 text-sm text-blue-600 hover:text-blue-800"
              >
                <ArrowLeft size={16} />
                <span>Back to Sign In</span>
              </button>
              <h2 className="text-lg font-semibold text-gray-900">Reset Password</h2>
              <p className="text-sm text-gray-600">Enter your email address and we'll send you a link to reset your password.</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                <input
                  type="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={forgotLoading}
                className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {forgotLoading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
          )
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>
            <button
              type="submit"
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition"
            >
              Sign In
            </button>
            <div className="text-center">
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Forgot Password?
              </button>
            </div>
            <div className="text-center border-t border-gray-100 pt-4">
              <span className="text-sm text-gray-500">New here? </span>
              <button
                type="button"
                onClick={() => setShowSignup(true)}
                className="text-sm font-medium text-blue-600 hover:text-blue-800"
              >
                Create an account
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ResetPasswordPage({ session, onComplete }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  // #194: wait briefly for Supabase to finish exchanging the recovery code
  // for a session. If still no session after 8 seconds, the link is bad
  // (expired, redirect URL not whitelisted, or token revoked) — surface
  // that to the user instead of leaving them staring at a disabled form.
  const [verifyTimedOut, setVerifyTimedOut] = useState(false);
  useEffect(() => {
    if (session) return;
    const t = setTimeout(() => setVerifyTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, [session]);

  const handleReset = async (e) => {
    e.preventDefault();
    if (!session) return;
    if (newPassword.length < 12) {
      alert('Password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      alert('Passwords do not match.');
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (error) {
      alert('Error resetting password: ' + formatUserError(error));
    } else {
      alert('Password updated successfully!');
      onComplete();
    }
  };

  const sessionPending = !session && !verifyTimedOut;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <img src="/naturals-diamond.png" alt="The Naturals" className="w-20 h-20 mx-auto mb-3 object-contain" />
          <h1 className="text-2xl font-bold text-gray-900">Set New Password</h1>
          <p className="text-gray-600 mt-2 text-sm">Enter your new password below.</p>
        </div>
        {sessionPending && (
          <div className="mb-4 bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2 rounded text-sm text-center">
            Verifying reset link...
          </div>
        )}
        {verifyTimedOut && !session && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded text-sm">
            <p className="font-medium">Reset link expired or invalid.</p>
            <p className="mt-1">Go back to the login screen and request a new reset email.</p>
            <button
              onClick={onComplete}
              className="mt-3 w-full bg-red-600 text-white py-2 rounded hover:bg-red-700 transition"
            >
              Back to login
            </button>
          </div>
        )}
        <form onSubmit={handleReset} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              required
              disabled={!session}
              minLength={12}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
              required
              disabled={!session}
              minLength={12}
            />
          </div>
          <button
            type="submit"
            disabled={saving || !session}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
          >
            {saving ? 'Updating...' : (!session ? 'Waiting for verification...' : 'Update Password')}
          </button>
        </form>
      </div>
    </div>
  );
}

function MainApp({ userRole, secondaryRole, userId, userName, userAvatar, onLogout, currentView, setCurrentView, workPortalView, setWorkPortalView, waiverSigned, setWaiverSigned, contractSigned, setContractSigned, loiSigned, setLoiSigned, facilityFineSigned, setFacilityFineSigned, nbpPlusAgreementSigned, setNbpPlusAgreementSigned, currentPortal, setCurrentPortal }) {
  const [viewProfileUserId, setViewProfileUserId] = useState(null);
  // #281: which Email Campaign sub-screen is open (send/history/templates/images/failed).
  const [emailCampaignSection, setEmailCampaignSection] = useState('send');
  const [navigateTeamId, setNavigateTeamId] = useState(null);
  // Lets the player dashboard's post-practice stats reminder (#278) open
  // Profile directly on the Practice Stats tab instead of the default one.
  // #438: ?view=stats (from the weekly reminder email) lands on the Stats tab.
  // The top-level App already turned that param into currentView='profile'
  // and stripped it, so read it before that happens: this initialiser runs on
  // MainApp's first mount, which is after the strip — hence the sessionStorage
  // hand-off below rather than re-reading window.location here.
  // #452: which booking screen Schedule should open on ('lessons' | 'facility'),
  // set by the private-lesson popup's two choices; cleared once Schedule reads it.
  const [scheduleInitialMode, setScheduleInitialMode] = useState(null);
  const [profileInitialTab, setProfileInitialTab] = useState(() => {
    try {
      const v = sessionStorage.getItem('nbp_deeplink_tab');
      if (v) { sessionStorage.removeItem('nbp_deeplink_tab'); return v; }
    } catch {}
    return null;
  });
  // #407: conversation to open when Schedule's "Message coach" jumps to Messages.
  const [messagesInitialConversationId, setMessagesInitialConversationId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // --- Profile "Back" behaviour -------------------------------------------
  // Remember WHICH list a profile was opened from and HOW FAR the user had
  // scrolled, so Back returns them to the same place instead of the top of
  // the Settings list. `profileReturn.view` replaces the old hard-coded
  // 'settings' target; `pendingScrollY` is applied once the list re-renders.
  const [profileReturn, setProfileReturn] = useState({ view: 'settings', scrollY: 0 });
  const [pendingScrollY, setPendingScrollY] = useState(null);

  // Athlete privacy: a player may only ever open their OWN full profile.
  // Every route into 'profile-view' goes through this predicate, and the
  // render gate re-checks it so a stale/persisted view can't slip through.
  // (`effectiveRole` is declared below but only read at call time.)
  const canViewProfileOf = (profileUserId) => effectiveRole !== 'player' || profileUserId === userId;

  // Opens a profile and records where we came from. Used by every list that
  // links to a profile (Settings, Manage Athletes, Teams, Coach Tools, ...).
  const openProfileFrom = (fromView) => (profileUserId) => {
    if (!canViewProfileOf(profileUserId)) return;
    setProfileReturn({ view: fromView, scrollY: window.scrollY });
    setViewProfileUserId(profileUserId);
    setCurrentView('profile-view');
    window.scrollTo(0, 0);
  };

  const backFromProfile = () => {
    setCurrentView(profileReturn.view);
    setPendingScrollY(profileReturn.scrollY);
  };

  // Lists fetch their rows on mount, so right after Back the page is still
  // short and scrolling would clamp to the top. Retry each frame (~2s max)
  // until the page is tall enough to land on the original position.
  useEffect(() => {
    if (pendingScrollY == null) return;
    let cancelled = false;
    let frames = 0;
    const tick = () => {
      if (cancelled) return;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (maxScroll >= pendingScrollY || frames > 120) {
        window.scrollTo(0, Math.min(pendingScrollY, maxScroll));
        setPendingScrollY(null);
        return;
      }
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [pendingScrollY]);
  const hasSecondary = !!secondaryRole && secondaryRole !== userRole;
  const [viewMode, setViewMode] = useState(userRole);
  useEffect(() => { setViewMode(userRole); }, [userRole]);
  const effectiveRole = hasSecondary ? viewMode : userRole;

  // If a coach toggles to "view as player", kick them out of the Work Portal too
  useEffect(() => {
    if (effectiveRole === 'player' && currentPortal === 'work') {
      setCurrentPortal('main');
    }
  }, [effectiveRole, currentPortal, setCurrentPortal]);

  const [profileIncomplete, setProfileIncomplete] = useState([]);
  const [showProfileReminder, setShowProfileReminder] = useState(false);

  // Private-lesson reminder (#234): nudge players who haven't booked a training
  // session in the last 2 months to schedule one. Shows once per session.
  const [showLessonReminder, setShowLessonReminder] = useState(false);

  // Birthday popup (#210): the logged-in user sees a greeting on their own
  // birthday; staff additionally see which players are celebrating today.
  const [showBirthday, setShowBirthday] = useState(false);
  const [birthdaySelf, setBirthdaySelf] = useState(false);
  const [birthdayPlayers, setBirthdayPlayers] = useState([]);

  useEffect(() => {
    if (effectiveRole !== 'player' || !userId) return;
    let cancelled = false;
    (async () => {
      const missing = [];
      // 1. Contact / physical / player info
      const { data: user } = await supabase
        .from('users')
        .select('full_name, email, phone, height, weight, date_of_birth, player_profiles!player_profiles_user_id_fkey(position, grade, bats, throws, jersey_number)')
        .eq('id', userId)
        .single();
      if (cancelled) return;
      if (user) {
        if (!user.phone) missing.push('Contact Information (phone)');
        if (!user.height && !user.weight && !user.date_of_birth) missing.push('Physical Information (height, weight, DOB)');
        const pp = Array.isArray(user.player_profiles) ? user.player_profiles[0] : user.player_profiles;
        if (!pp || (!pp.position && !pp.grade && !pp.bats && !pp.throws)) missing.push('Player Information (position, grade, bats/throws)');
      }
      // 2. Equipment sizes
      const { data: equip } = await supabase.from('equipment_sizes').select('id').eq('user_id', userId).limit(1);
      if (cancelled) return;
      if (!equip || equip.length === 0) missing.push('Equipment Sizes');
      // 3. Goals — check user_goals (player-authored) not player_notes (staff-only)
      const { data: goals } = await supabase.from('user_goals').select('id').eq('user_id', userId).limit(1);
      if (cancelled) return;
      if (!goals || goals.length === 0) missing.push('Goals');
      // 4. Documents (waiver)
      if (!waiverSigned) missing.push('Documents (waiver not signed)');

      if (!cancelled && missing.length > 0) {
        setProfileIncomplete(missing);
        // Only show once per session
        const key = `profile_reminder_${userId}`;
        if (!sessionStorage.getItem(key)) {
          setShowProfileReminder(true);
          sessionStorage.setItem(key, '1');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [userId, effectiveRole, waiverSigned]); // eslint-disable-line react-hooks/exhaustive-deps

  // Private-lesson reminder (#234): if a player's most recent booked/confirmed
  // session is more than 2 months old (or they've never booked), prompt them to
  // schedule one. Once per browser session so it isn't nagging on every view.
  useEffect(() => {
    if (effectiveRole !== 'player' || !userId) return;
    let cancelled = false;
    (async () => {
      const key = `lesson_reminder_${userId}`;
      if (sessionStorage.getItem(key)) return;
      const { data: rows } = await supabase
        .from('slot_reservations')
        .select('slot_date')
        .eq('player_id', userId)
        .in('status', ['confirmed', 'pending'])
        .order('slot_date', { ascending: false })
        .limit(1);
      if (cancelled) return;
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      const latest = rows && rows[0] ? new Date(rows[0].slot_date + 'T00:00:00') : null;
      // No bookings, or the latest booking is older than 2 months → remind.
      if (!latest || latest < twoMonthsAgo) {
        setShowLessonReminder(true);
        sessionStorage.setItem(key, '1');
      }
    })();
    return () => { cancelled = true; };
  }, [userId, effectiveRole]);

  // Birthday check (#210) — runs for every role; shows at most once per day.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const now = new Date();
      const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const seenKey = `birthday_popup_${userId}_${now.getFullYear()}-${mmdd}`;
      if (sessionStorage.getItem(seenKey)) return;

      // Own birthday (date_of_birth is 'YYYY-MM-DD'; compare the MM-DD portion)
      const { data: me } = await supabase.from('users').select('date_of_birth').eq('id', userId).single();
      if (cancelled) return;
      const self = !!(me?.date_of_birth && me.date_of_birth.slice(5) === mmdd);

      // Staff also see players whose birthday is today
      let players = [];
      if (userRole === 'admin' || userRole === 'coach') {
        // #437: paged, and ordered — an unordered read past the 1,000-row
        // clamp would drop a random slice of players rather than a predictable one.
        const { rows } = await readAllPages(() => supabase
          .from('users')
          .select('id, full_name, date_of_birth')
          .eq('role', 'player')
          .not('date_of_birth', 'is', null)
          .order('id'));
        if (cancelled) return;
        players = rows
          .filter(r => r.id !== userId && r.date_of_birth && r.date_of_birth.slice(5) === mmdd)
          .map(r => ({ id: r.id, full_name: r.full_name }));
      }

      if (cancelled) return;
      if (self || players.length > 0) {
        setBirthdaySelf(self);
        setBirthdayPlayers(players);
        setShowBirthday(true);
        sessionStorage.setItem(seenKey, '1');
      }
    })();
    return () => { cancelled = true; };
  }, [userId, userRole]); // eslint-disable-line react-hooks/exhaustive-deps

  // #350: Escape closes these three login popups. All three are read-only —
  // there is nothing typed in them to throw away — and all three write their
  // "already seen" flag when they OPEN, not when they are dismissed, so
  // closing this way loses nothing. They can stack, so close the top one
  // first: one press per popup, in the order they render.
  useEffect(() => {
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (showBirthday) { setShowBirthday(false); return; }
      if (showLessonReminder) { setShowLessonReminder(false); return; }
      if (showProfileReminder) { setShowProfileReminder(false); }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [showBirthday, showLessonReminder, showProfileReminder]);

  const mainCounts = useMainPortalCounts(userId, effectiveRole);
  const workCounts = useWorkPortalCounts(userId, effectiveRole);
  // #224: players only, and only when the server positively reports no linked
  // WHOOP. `effectiveRole` rather than `userRole` so an admin using "View as
  // Coach" is not nagged about an athlete account they do not have.
  const needsWhoop = useWhoopNudge(userId, effectiveRole);

  const handleNotifJump = (portal, view) => {
    if (portal === 'main') setCurrentView(view);
    else { setWorkPortalView(view); setCurrentPortal('work'); }
  };

  // #224: the WHOOP tab lives inside Profile, so this opens the profile with
  // that tab already selected rather than dropping the athlete on the profile
  // page to go hunting for it. 'whoop' is an accepted initialTab
  // (Profile.js:83) and a player may see the tab on their own profile
  // (Profile.js:2441).
  const handleOpenWhoop = () => {
    setProfileInitialTab('whoop');
    setCurrentView('profile');
  };

  // #316: shared with WorkPortal.js — see deletePendingPayment in NotificationBell.js
  const handleDeletePayment = (purchaseId, productName) => deletePendingPayment(purchaseId, productName, mainCounts.refresh);

  // #408: dismissing writes the coach's own row, so it needs the real userId —
  // NOT a role-scoped or "viewing as" identity. effectiveRole exists to scope
  // the UI (users.secondary_role, see CLAUDE.md); the row still belongs to the
  // person actually signed in, and the own-only RLS on
  // facility_event_notice_reads would reject anything else anyway.
  const handleDismissEventAssignment = (eventId) => dismissEventAssignment(eventId, userId, mainCounts.refresh);

  // #402: open the athlete's profile with the Physical Therapy tab already
  // selected ('pt' is a Health sub-tab key, Profile.js:582). Routed through
  // openProfileFrom so it goes past canViewProfileOf and records a Back
  // target like every other link into a profile — a player never reaches this
  // (the notice only exists for coach/admin), and the gate is what makes that
  // structural rather than a promise.
  const handleOpenAthletePt = (playerId) => {
    if (!playerId) return;
    setProfileInitialTab('pt');
    openProfileFrom(currentView)(playerId);
  };

  // #402: the read marker is this browser's, keyed on the real signed-in
  // userId — not effectiveRole's "viewing as" identity, same reasoning as
  // handleDismissEventAssignment above.
  const handleDismissPtNotice = (visitId) => dismissPtVisitNotice(visitId, userId, mainCounts.refresh);
  const handleDismissAllPtNotices = () => markAllPtVisitNoticesSeen(userId, mainCounts.refresh);

  // #438: the weekly check-in opens the athlete's OWN profile on the Stats
  // tab ('stats' is a top-level profile tab, Profile.js:90).
  const handleOpenWeeklyReminder = () => {
    setProfileInitialTab('stats');
    setCurrentView('profile');
  };
  const handleDismissWeeklyReminder = (reminderId) => dismissWeeklyReminder(reminderId, mainCounts.refresh);

  // #443: a WHOOP nudge opens the athlete's own WHOOP tab — the same place
  // the "connect WHOOP" nudge lands (handleOpenWhoop above).
  const handleDismissWhoopNudge = (nudgeId) => dismissWhoopNudge(nudgeId, mainCounts.refresh);

  if (currentPortal === 'work' && (userRole === 'coach' || userRole === 'admin')) {
    return (
      <WorkPortalShell
        userId={userId}
        userRole={userRole}
        userName={userName}
        userAvatar={userAvatar}
        onLogout={onLogout}
        currentView={workPortalView}
        setCurrentView={setWorkPortalView}
        onSwitchPortal={() => setCurrentPortal('main')}
        onSwitchPortalAndView={(view) => { setCurrentView(view); setCurrentPortal('main'); }}
      />
    );
  }

  const handleNav = (view) => { setCurrentView(view); setSidebarOpen(false); };

  return (
    <div className="flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <Sidebar
        userRole={effectiveRole}
        userName={userName}
        userAvatar={userAvatar}
        currentView={currentView}
        setCurrentView={(v) => handleNav(v)}
        onLogout={onLogout}
        unreadMessageCount={mainCounts.unreadMessages}
        pendingSlotCount={mainCounts.pendingSlots.length}
        waiverSigned={waiverSigned}
        contractSigned={contractSigned}
        loiSigned={loiSigned}
        facilityFineSigned={facilityFineSigned}
        nbpPlusAgreementSigned={nbpPlusAgreementSigned}
        onEmailCampaignNav={(key) => { setEmailCampaignSection(key); handleNav('email-campaigns'); }}
        onSwitchPortal={() => { setCurrentPortal('work'); setSidebarOpen(false); }}
        canSwitchRole={hasSecondary}
        otherRole={hasSecondary ? (viewMode === userRole ? secondaryRole : userRole) : null}
        onSwitchRole={hasSecondary ? () => { setViewMode(viewMode === userRole ? secondaryRole : userRole); setSidebarOpen(false); } : null}
        mobileOpen={sidebarOpen}
      />
      <div className="flex-1 min-w-0 md:ml-64">
        <div className="sticky top-0 z-30 bg-white border-b px-4 md:px-8 py-3 flex items-center justify-between">
          <button onClick={() => setSidebarOpen(true)} className="md:hidden p-1 text-gray-600 hover:text-gray-900">
            <Menu size={24} />
          </button>
          <div className="flex-1" />
          <NotificationBell
            currentPortal="main"
            mainCounts={mainCounts}
            workCounts={workCounts}
            onJump={handleNotifJump}
            userRole={effectiveRole}
            onDeletePayment={handleDeletePayment}
            needsWhoop={needsWhoop}
            onOpenWhoop={handleOpenWhoop}
            onDismissEventAssignment={handleDismissEventAssignment}
            onOpenAthletePt={handleOpenAthletePt}
            onDismissPtNotice={handleDismissPtNotice}
            onDismissAllPtNotices={handleDismissAllPtNotices}
            onOpenWeeklyReminder={handleOpenWeeklyReminder}
            onDismissWeeklyReminder={handleDismissWeeklyReminder}
            onOpenWhoopNudge={handleOpenWhoop}
            onDismissWhoopNudge={handleDismissWhoopNudge}
          />
        </div>

        {/* Main content */}
        <div className="p-4 md:p-8">
          <div className="max-w-7xl mx-auto">
            {currentView === 'dashboard' && (
              effectiveRole === 'player' ? (
                /* #417: onOpenProfileTab is the same deep-link mechanism #278's
                   onOpenPracticeStats already uses (set profileInitialTab, switch
                   view) — generalised so the Explore carousel can open Goals,
                   Arm Care, Assessments and Notes. Profile.js maps sub-tab keys
                   to their parent tab. */
                <PlayerDashboard userId={userId} waiverSigned={waiverSigned} setCurrentView={setCurrentView} onOpenPracticeStats={() => { setProfileInitialTab('practice_stats'); setCurrentView('profile'); }} onOpenProfileTab={(tab) => { setProfileInitialTab(tab); setCurrentView('profile'); }} />
              ) : (
                <AdminDashboard userId={userId} userRole={effectiveRole} setCurrentView={setCurrentView} />
              )
            )}
            {currentView === 'profile' && <Profile userId={userId} userRole={effectiveRole} loggedInUserId={userId} initialTab={profileInitialTab} onInitialTabHandled={() => setProfileInitialTab(null)} onNavigateToProfile={openProfileFrom('profile')} onNavigateToTeam={(teamId) => { setNavigateTeamId(teamId); setCurrentView('team'); }} />}
            {/* #402 added initialTab here. It was already threaded into the own-profile
                render above; profile-view had no way to deep-link a tab, which is what
                the PT notice needs (it opens someone else's Physical Therapy tab).
                Profile clears it through onInitialTabHandled, so the next ordinary
                visit still lands on General. */}
            {currentView === 'profile-view' && viewProfileUserId && canViewProfileOf(viewProfileUserId) && <Profile userId={viewProfileUserId} userRole={effectiveRole} loggedInUserId={userId} initialTab={profileInitialTab} onInitialTabHandled={() => setProfileInitialTab(null)} onBack={backFromProfile} onNavigateToProfile={effectiveRole === 'player' ? null : (profileUserId) => { setViewProfileUserId(profileUserId); window.scrollTo(0, 0); }} onNavigateToTeam={(teamId) => { setNavigateTeamId(teamId); setCurrentView('team'); }} />}
            {/* Athletes get the roster read-only: no profile links off teammate/coach cards. */}
            {currentView === 'team' && <MyTeam userId={userId} userRole={effectiveRole} initialTeamId={navigateTeamId} onNavigateToProfile={effectiveRole === 'player' ? null : openProfileFrom('team')} />}
            {currentView === 'training-groups' && (effectiveRole === 'admin' || effectiveRole === 'coach') && <TrainingGroups userId={userId} userRole={effectiveRole} onNavigateToProfile={openProfileFrom('training-groups')} />}
            {currentView === 'schedule' && <Schedule userId={userId} userRole={effectiveRole} initialMode={scheduleInitialMode} onInitialModeHandled={() => setScheduleInitialMode(null)} onMessageCoach={(conversationId) => { setMessagesInitialConversationId(conversationId); setCurrentView('messages'); }} />}
            {currentView === 'knowledge' && <KnowledgeBase userId={userId} userRole={effectiveRole} />}
            {currentView === 'fields' && <Fields userId={userId} userRole={effectiveRole} />}
            {currentView === 'messages' && <Messages userId={userId} userRole={effectiveRole} initialConversationId={messagesInitialConversationId} onInitialConversationHandled={() => setMessagesInitialConversationId(null)} />}
            {/* #281: admin only — this screen fronts a 937-address mailing list. Whether
                coaches should get it too is an open question for Cordell, flagged in the PR. */}
            {currentView === 'email-campaigns' && (userRole === 'admin' || userRole === 'coach') && <EmailCampaigns userId={userId} userRole={userRole} section={emailCampaignSection} onSectionChange={setEmailCampaignSection} />}
            {currentView === 'manage-athletes' && (userRole === 'admin' || userRole === 'coach') && <ManageAthletes userId={userId} userRole={effectiveRole} onNavigateToProfile={openProfileFrom('manage-athletes')} />}
            {currentView === 'manage-coaches' && userRole === 'admin' && <ManageCoaches userId={userId} userRole={effectiveRole} mode="coaches" onNavigateToProfile={openProfileFrom('manage-coaches')} />}
            {currentView === 'manage-interns' && userRole === 'admin' && <ManageCoaches userId={userId} userRole={effectiveRole} mode="interns" onNavigateToProfile={openProfileFrom('manage-interns')} />}
            {/* manage-interns retained above as a deep-link alias; the sidebar now uses the merged Coaches/Interns view */}
            {currentView === 'coach-tools' && <CoachTools userRole={effectiveRole} userId={userId} onNavigateToProfile={openProfileFrom('coach-tools')} />}
            {currentView === 'programming' && (effectiveRole === 'admin' || effectiveRole === 'coach') && <Programming userId={userId} userRole={effectiveRole} />}
            {currentView === 'waiver' && <WaiverPage userId={userId} userRole={effectiveRole} onSigned={() => setWaiverSigned(true)} />}
            {currentView === 'contract' && <ContractPage userId={userId} userRole={effectiveRole} onSigned={() => setContractSigned(true)} />}
            {currentView === 'loi' && <LetterOfIntentPage userId={userId} userRole={effectiveRole} onSigned={() => setLoiSigned(true)} />}
            {currentView === 'facility-fine' && <FacilityFinePage userId={userId} onSigned={() => setFacilityFineSigned(true)} />}
            {currentView === 'nbp-plus-agreement' && <NbpPlusAgreementPage userId={userId} userRole={effectiveRole} onSigned={() => setNbpPlusAgreementSigned(true)} />}
            {currentView === 'settings' && (userRole === 'admin' || userRole === 'coach') && <AdminSettings userId={userId} userRole={effectiveRole} onNavigateToProfile={openProfileFrom('settings')} />}
          </div>
        </div>
      </div>

      {/* Profile completeness reminder modal */}
      {showProfileReminder && profileIncomplete.length > 0 && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowProfileReminder(false); }}
        >
          {/* #350: the missing-sections list has no fixed length, and both
              buttons sit below it. Uncapped, a long list pushed "Go to
              Profile" and "Dismiss" off the bottom of a `fixed` overlay that
              the page cannot scroll. The list now scrolls; the buttons sit in
              a footer outside it and are always reachable. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 pt-6 pb-4 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <AlertCircle size={20} className="text-amber-600" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-900">Complete Your Profile</h3>
                  <p className="text-sm text-gray-500">The following sections still need to be filled out:</p>
                </div>
              </div>
            </div>
            <div className="px-6 overflow-y-auto flex-1 min-h-0">
              <ul className="space-y-2 pb-4">
                {profileIncomplete.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <X size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                    <span className="break-words min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-gray-200 px-6 py-4 flex gap-3 flex-shrink-0">
              <button
                onClick={() => { setShowProfileReminder(false); setCurrentView('profile'); }}
                className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition"
              >
                Go to Profile
              </button>
              <button
                onClick={() => setShowProfileReminder(false)}
                className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-50 transition"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Private-lesson reminder modal (#234) */}
      {showLessonReminder && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowLessonReminder(false); }}
        >
          {/* #350 sweep: same shape as the other two login popups — capped
              height, scrolling body, buttons in a footer — so a short window
              (a phone held sideways) can still reach them. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 pt-6 pb-4 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-teal-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <Calendar size={20} className="text-teal-600" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-900">Time for a Private Lesson?</h3>
                  <p className="text-sm text-gray-500">It's been a while since your last session.</p>
                </div>
              </div>
            </div>
            <div className="px-6 pb-4 overflow-y-auto flex-1 min-h-0">
              <p className="text-sm text-gray-700">
                Staying consistent is key to development. Book a private lesson with your coach to keep
                building on your progress.
              </p>
              {/* #452: "Book a Session" used to drop athletes on their own My
                  Schedule calendar, which has nothing to book. Two real
                  destinations now. */}
              <div className="mt-4 space-y-2">
                <button
                  onClick={() => { setShowLessonReminder(false); setScheduleInitialMode('lessons'); setCurrentView('schedule'); }}
                  className="w-full text-left px-4 py-3 rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition"
                >
                  <div className="font-semibold">Private lesson</div>
                  <div className="text-xs text-teal-50">See every coach's open lesson times and reserve one.</div>
                </button>
                <button
                  onClick={() => { setShowLessonReminder(false); setScheduleInitialMode('facility'); setCurrentView('schedule'); }}
                  className="w-full text-left px-4 py-3 rounded-lg border border-teal-600 text-teal-800 hover:bg-teal-50 transition"
                >
                  <div className="font-semibold">Facility time</div>
                  <div className="text-xs text-gray-600">NBP+ hour blocks, assessments, S&amp;C and cage rentals.</div>
                </button>
              </div>
            </div>
            <div className="border-t border-gray-200 px-6 py-4 flex gap-3 flex-shrink-0">
              <button
                onClick={() => setShowLessonReminder(false)}
                className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg font-medium hover:bg-gray-50 transition"
              >
                Maybe Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Birthday popup (#210) */}
      {showBirthday && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowBirthday(false); }}
        >
          {/* #350: the birthday list has no upper bound and the only dismiss
              control sits under it, so on a day with enough shared birthdays
              this blocking popup — which every role gets at login — pushed
              Close off the screen and made the whole app unusable until a
              reload. The list scrolls now and Close lives in a fixed footer. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 pt-6 pb-4 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-pink-100 rounded-full flex items-center justify-center text-2xl flex-shrink-0">🎂</div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-900">
                    {birthdaySelf ? 'Happy Birthday!' : 'Birthdays Today'}
                  </h3>
                  <p className="text-sm text-gray-500 line-clamp-2 break-words">
                    {birthdaySelf
                      ? `Wishing you a great day, ${(userName || '').split(' ')[0] || 'champ'}! 🎉`
                      : 'From everyone at Naturals 🎉'}
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 pb-4 overflow-y-auto flex-1 min-h-0">
              {birthdaySelf && (
                <p className="text-sm text-gray-700 mb-4">
                  🎉 Everyone at Naturals Baseball wishes you a fantastic birthday. Have a great one!
                </p>
              )}
              {birthdayPlayers.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-gray-700 mb-2">Players celebrating today:</p>
                  <ul className="space-y-1">
                    {birthdayPlayers.map(p => (
                      <li key={p.id}>
                        {/* The list is only populated for staff, but a coach in
                            "view as player" mode must not deep-link into another
                            athlete's profile either — show plain text instead. */}
                        {effectiveRole === 'player' ? (
                          <span className="text-sm text-gray-700 flex items-center gap-1.5">
                            🎉 {p.full_name}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setShowBirthday(false); openProfileFrom('dashboard')(p.id); }}
                            className="text-sm text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1.5 text-left"
                          >
                            🎉 {p.full_name}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="border-t border-gray-200 px-6 py-4 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowBirthday(false)}
                className="w-full bg-blue-600 text-white py-2 rounded-lg font-medium hover:bg-blue-700 transition"
              >
                {birthdaySelf ? 'Thanks!' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Sidebar({ userRole, userName, userAvatar, currentView, setCurrentView, onLogout, unreadMessageCount = 0, pendingSlotCount = 0, waiverSigned, contractSigned, loiSigned, facilityFineSigned, nbpPlusAgreementSigned, onEmailCampaignNav, onSwitchPortal, canSwitchRole, otherRole, onSwitchRole, mobileOpen }) {
  const [documentsExpanded, setDocumentsExpanded] = useState(true);
  const [emailCampaignExpanded, setEmailCampaignExpanded] = useState(false);
  // #371: Communication is an expandable parent for admins only (Email Campaign
  // lives inside it). Defaults CLOSED, unlike documentsExpanded: Documents opens
  // by default because its children carry the red "unsigned" dots a player needs
  // to notice, whereas Communication's own one-click destination (messages) is
  // the thing admins want most of the time. Closed also means the sidebar is
  // exactly as tall as it is today for every role on first paint, and it matches
  // emailCampaignExpanded's existing `false` default rather than fighting it.
  const [communicationExpanded, setCommunicationExpanded] = useState(false);
  const anyDocUnsigned = waiverSigned === false || contractSigned === false || loiSigned === false || facilityFineSigned === false || nbpPlusAgreementSigned === false;
  return (
    <div className={`w-64 bg-gray-900 text-white h-screen fixed left-0 top-0 p-4 flex flex-col z-50 transition-transform duration-200 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}>
      <div className="mb-4">
        <div className="flex items-center space-x-2">
          <img src="/naturals-diamond.png" alt="The Naturals" className="w-8 h-8 object-contain" />
          <h1 className="text-xl font-bold text-blue-200">Natural Ball Player</h1>
        </div>
        <div className="flex items-center space-x-3 mt-2">
          {userAvatar ? (
            <img src={userAvatar} alt="Avatar" className="w-8 h-8 rounded-full object-cover" />
          ) : (
            <div className="w-8 h-8 bg-blue-200 rounded-full flex items-center justify-center text-blue-900 text-xs font-bold">
              {userName?.charAt(0) || '?'}
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-gray-200 truncate">{userName || 'User'}</p>
            <p className="text-xs text-gray-400">{userRole?.toUpperCase()}</p>
          </div>
        </div>
      </div>

      <nav className="space-y-1 flex-1 overflow-y-auto">
        <button
          onClick={() => setCurrentView('dashboard')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
            currentView === 'dashboard' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
          }`}
        >
          <BarChart3 size={18} />
          <span className="flex-1 text-left">Dashboard</span>
          {(userRole === 'coach' || userRole === 'admin') && pendingSlotCount > 0 && (
            <span className="bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1">{pendingSlotCount}</span>
          )}
        </button>

        <button
          onClick={() => setCurrentView('profile')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
            currentView === 'profile' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
          }`}
        >
          <Users size={18} />
          <span>Profile</span>
        </button>

        {/* Documents Section */}
        <div>
          <button
            onClick={() => setDocumentsExpanded(!documentsExpanded)}
            className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm hover:bg-gray-800`}
          >
            <FolderOpen size={18} />
            <span className="flex-1 text-left">Documents</span>
            {anyDocUnsigned && (
              <span className="w-2.5 h-2.5 bg-red-500 rounded-full flex-shrink-0"></span>
            )}
            {documentsExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {documentsExpanded && (
            <div className="ml-4 space-y-1 mt-1">
              <button
                onClick={() => setCurrentView('waiver')}
                className={`w-full flex items-center space-x-3 px-4 py-2 rounded-lg transition text-sm ${
                  currentView === 'waiver' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                }`}
              >
                <FileText size={16} />
                <span className="flex-1 text-left">Waiver</span>
                {waiverSigned === false && (
                  <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></span>
                )}
              </button>
              <button
                onClick={() => setCurrentView('contract')}
                className={`w-full flex items-center space-x-3 px-4 py-2 rounded-lg transition text-sm ${
                  currentView === 'contract' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                }`}
              >
                <FileText size={16} />
                <span className="flex-1 text-left">Player Contract</span>
                {contractSigned === false && (
                  <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></span>
                )}
              </button>
              <button
                onClick={() => setCurrentView('loi')}
                className={`w-full flex items-center space-x-3 px-4 py-2 rounded-lg transition text-sm ${
                  currentView === 'loi' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                }`}
              >
                <FileText size={16} />
                <span className="flex-1 text-left">Letter of Intent</span>
                {loiSigned === false && (
                  <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></span>
                )}
              </button>
              <button
                onClick={() => setCurrentView('facility-fine')}
                className={`w-full flex items-center space-x-3 px-4 py-2 rounded-lg transition text-sm ${
                  currentView === 'facility-fine' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                }`}
              >
                <FileText size={16} />
                <span className="flex-1 text-left">Facility Fine</span>
                {facilityFineSigned === false && (
                  <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></span>
                )}
              </button>
              {/* #440: only NBP+ athletes (training-group members) see this. */}
              {nbpPlusAgreementSigned !== null && (
                <button
                  onClick={() => setCurrentView('nbp-plus-agreement')}
                  className={`w-full flex items-center space-x-3 px-4 py-2 rounded-lg transition text-sm ${
                    currentView === 'nbp-plus-agreement' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                  }`}
                >
                  <FileText size={16} />
                  <span className="flex-1 text-left">NBP+ Agreement</span>
                  {nbpPlusAgreementSigned === false && (
                    <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></span>
                  )}
                </button>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => setCurrentView('team')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
            currentView === 'team' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
          }`}
        >
          <Users size={18} />
          <span>My Team</span>
        </button>

        <button
          onClick={() => setCurrentView('schedule')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
            currentView === 'schedule' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
          }`}
        >
          <Calendar size={18} />
          <span>Schedule</span>
        </button>

        <button
          onClick={() => setCurrentView('fields')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
            currentView === 'fields' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
          }`}
        >
          <MapPin size={18} />
          <span>Fields</span>
        </button>

        <button
          onClick={() => setCurrentView('knowledge')}
          className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
            currentView === 'knowledge' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
          }`}
        >
          <BookOpen size={18} />
          <span>Knowledge Base</span>
        </button>

        {/* #371: Cordell did NOT want the two buttons swapped — he wanted Email
            Campaign to live INSIDE Communication, "since it is a form of
            communication", the way Waiver / Player Contract / Letter of Intent /
            Facility Fine live inside Documents above.

            The catch: Communication has no role gate (every role sees it) while
            the Email Campaign block is admin-only, because it fronts the full
            937-address mailing list. Moving Communication inside the admin block
            would have deleted it for every athlete and coach. So Communication
            stays exactly where it is and stays ungated; it merely GAINS an
            expander, and only for admins.

            Role visibility, stated plainly:
              • player / coach  → the same single button as before. Same classes,
                same one-click navigate to 'messages', same unread badge, no
                chevron, no children. Rendered from the untouched branch below.
              • admin           → the identical button plus a sibling chevron
                that reveals the Email Campaign group beneath it. The label
                itself still navigates to 'messages' in one click.
            The chevron is a SIBLING button, not a nested one: a <button> inside
            a <button> is invalid HTML and the inner click never fires. */}
        {(() => {
          // Shared inner markup so the two branches cannot drift apart.
          const communicationInner = (
            <>
              <MessageSquare size={18} />
              <span className="flex-1 text-left">Communication</span>
              {unreadMessageCount > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold rounded-full h-5 min-w-[20px] flex items-center justify-center px-1">{unreadMessageCount > 99 ? '99+' : unreadMessageCount}</span>
              )}
            </>
          );
          // #390: Cordell asked for "admins AND coaches" to see Campaign History
          // and Failed Emails, and RLS on all three email_* tables already
          // permits admin+coach SELECT. So coaches now get the group too — but
          // the "Send Email Campaign" child is filtered out for them below,
          // because sending is the one irreversible button in the app and
          // nobody asked to give coaches that.
          if (userRole !== 'admin' && userRole !== 'coach') {
            // Byte-for-byte the button players see today.
            return (
              <button
                onClick={() => setCurrentView('messages')}
                className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                  currentView === 'messages' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                }`}
              >
                {communicationInner}
              </button>
            );
          }
          return (
            <div>
              <div
                className={`w-full flex items-center rounded-lg transition text-sm ${
                  currentView === 'messages' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                }`}
              >
                <button
                  onClick={() => setCurrentView('messages')}
                  className="flex-1 min-w-0 flex items-center space-x-3 px-3 py-2 text-left rounded-lg"
                >
                  {communicationInner}
                </button>
                <button
                  onClick={() => setCommunicationExpanded(!communicationExpanded)}
                  className="shrink-0 px-2 py-2 rounded-lg"
                  aria-expanded={communicationExpanded}
                  aria-label={communicationExpanded ? 'Hide Email Campaign' : 'Show Email Campaign'}
                  title={communicationExpanded ? 'Hide Email Campaign' : 'Show Email Campaign'}
                >
                  {communicationExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
              </div>
              {communicationExpanded && (
                <div className="ml-4 space-y-1 mt-1">
                  {/* #281: Email Campaign — EZFacility-style sub-folders. Admin
                      only: this fronts the full 937-address mailing list.
                      #371: now a child of Communication. Kept as ONE named
                      sub-item that expands rather than flattening its five
                      children up a level, so the words "Email Campaign" — the
                      words Cordell used — still appear in the sidebar, so the
                      existing 'email-campaigns' highlight still has something to
                      highlight, and so an open Communication costs one line
                      instead of five.

                      K2: the third level has to earn its width. Measured, the
                      earlier ml-3/px-3 left 144px for a label and "Email
                      Template Library" needs 161px and "Send Email Campaign"
                      155px, so two of the five wrapped onto a second line. The
                      children below are now ml-2 / px-2 / space-x-2, with a 14px
                      icon and text-xs, which leaves 162px of label width and
                      needs at most 138px — every one of the five fits on one
                      line with room to spare, and none is renamed or truncated.
                      text-xs also reads as the third level it now is: the tab
                      bar is text-sm, and these sit two steps under it. */}
                  <div>
                    <button
                      onClick={() => setEmailCampaignExpanded(!emailCampaignExpanded)}
                      className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                        currentView === 'email-campaigns' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                      }`}
                    >
                      <Mail size={18} />
                      <span className="flex-1 text-left">Email Campaign</span>
                      {emailCampaignExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    {emailCampaignExpanded && (
                      <div className="ml-2 space-y-1 mt-1">
                        {[
                          { key: 'send', label: 'Send Email Campaign', adminOnly: true },
                          { key: 'history', label: 'Campaign History' },
                          { key: 'templates', label: 'Email Template Library' },
                          { key: 'images', label: 'Email Image Library' },
                          { key: 'failed', label: 'Failed Emails' },
                        ].filter(item => !item.adminOnly || userRole === 'admin').map(item => (
                          <button
                            key={item.key}
                            onClick={() => onEmailCampaignNav && onEmailCampaignNav(item.key)}
                            className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg transition text-xs hover:bg-gray-800"
                          >
                            <Mail size={14} className="shrink-0" />
                            <span className="flex-1 text-left">{item.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {(userRole === 'admin' || userRole === 'coach') && (
          <>
            <button
              onClick={() => setCurrentView('training-groups')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                currentView === 'training-groups' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
              }`}
            >
              <Layers size={18} />
              <span>Training Groups</span>
            </button>

            {userRole === 'admin' && (
              <>
                <button
                  onClick={() => setCurrentView('manage-coaches')}
                  className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                    currentView === 'manage-coaches' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
                  }`}
                >
                  <UserCog size={18} />
                  <span>Manage Coaches / Interns</span>
                </button>
              </>
            )}

            <button
              onClick={() => setCurrentView('coach-tools')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                currentView === 'coach-tools' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
              }`}
            >
              <Wrench size={18} />
              <span>Coach Tools</span>
            </button>
            <button
              onClick={() => setCurrentView('programming')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                currentView === 'programming' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
              }`}
            >
              <Dumbbell size={18} />
              <span>Programming</span>
            </button>

            <button
              onClick={() => setCurrentView('settings')}
              className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
                currentView === 'settings' ? 'bg-blue-200 text-blue-900' : 'hover:bg-gray-800'
              }`}
            >
              <Settings size={18} />
              <span>Settings</span>
            </button>

          </>
        )}
      </nav>

      <div className="mt-auto pt-3 space-y-1.5">
        {canSwitchRole && onSwitchRole && otherRole && (
          <button
            onClick={onSwitchRole}
            className="w-full flex items-center justify-center space-x-2 bg-blue-200 text-blue-900 px-4 py-2 rounded-lg hover:bg-blue-300 transition text-sm font-medium"
            title={`Currently viewing as ${userRole}`}
          >
            <UserCog size={16} />
            <span>View as {otherRole.charAt(0).toUpperCase() + otherRole.slice(1)}</span>
          </button>
        )}
        {(userRole === 'coach' || userRole === 'admin') && onSwitchPortal && (
          <button
            onClick={onSwitchPortal}
            className="w-full flex items-center justify-center space-x-2 bg-indigo-200 text-indigo-900 px-4 py-2 rounded-lg hover:bg-indigo-300 transition text-sm"
          >
            <Briefcase size={16} />
            <span>Switch to Work Portal</span>
          </button>
        )}
        <button
          onClick={onLogout}
          className="w-full bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

function AdminDashboard({ userId, userRole, setCurrentView }) {
  const [pendingRequests, setPendingRequests] = useState([]);
  const [todaySessions, setTodaySessions] = useState([]);
  const [openSlots, setOpenSlots] = useState([]);
  const [todayFacilityEvents, setTodayFacilityEvents] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [activityTotals, setActivityTotals] = useState(null);

  const formatTime = (time) => {
    if (!time) return '';
    const [h, m] = time.split(':');
    const hour = parseInt(h);
    return `${hour % 12 || 12}:${m} ${hour >= 12 ? 'PM' : 'AM'}`;
  };

  useEffect(() => {
    if (userId) {
      fetchTrainingSessions();
      fetchTodayFacilityEvents();
      fetchNotifications();
      fetchActivityTotals();
    }
  }, [userId]);

  const fetchActivityTotals = async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const todayStr = fmtLocalDate(today);
    const weekStartStr = fmtLocalDate(weekStart);
    const monthStartStr = fmtLocalDate(monthStart);

    const countOn = async (table, dateCol, type) => {
      const ranges = ['day', 'week', 'month'];
      const starts = { day: todayStr, week: weekStartStr, month: monthStartStr };
      const out = {};
      for (const r of ranges) {
        let q = supabase.from(table).select('id', { count: 'exact', head: true })
          .gte(dateCol, starts[r]).lte(dateCol, todayStr);
        if (type) q = q.eq('event_type', type);
        const { count } = await q;
        out[r] = count || 0;
      }
      return out;
    };

    const countSlotReservations = async () => {
      const ranges = ['day', 'week', 'month'];
      const starts = { day: todayStr, week: weekStartStr, month: monthStartStr };
      const out = {};
      for (const r of ranges) {
        const { count } = await supabase.from('slot_reservations')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'confirmed')
          .gte('slot_date', starts[r]).lte('slot_date', todayStr);
        out[r] = count || 0;
      }
      return out;
    };

    const [assessments, lessons, practices, games, workouts] = await Promise.all([
      countOn('assessment_submissions', 'assessment_date', null),
      countSlotReservations(),
      countOn('schedule_events', 'event_date', 'practice'),
      countOn('schedule_events', 'event_date', 'game'),
      countOn('schedule_events', 'event_date', 'workout'),
    ]);

    setActivityTotals({ assessments, lessons, practices, games, workouts });
  };

  const fetchTodayFacilityEvents = async () => {
    const today = fmtLocalDate(new Date());
    const todayDow = new Date().getDay();

    const { data: nonRecurring } = await supabase.from('facility_events').select('*').eq('is_recurring', false).is('recurrence_parent_id', null).eq('event_date', today);
    const { data: masters } = await supabase.from('facility_events').select('*').eq('is_recurring', true).is('recurrence_parent_id', null);

    const events = [...(nonRecurring || [])];
    (masters || []).forEach(master => {
      const masterDate = new Date(master.event_date + 'T00:00:00');
      const todayDate = new Date(today + 'T00:00:00');
      if (todayDate >= masterDate) {
        const masterDow = masterDate.getDay();
        if (masterDow === todayDow) {
          if (!master.recurrence_end_date || todayDate <= new Date(master.recurrence_end_date + 'T00:00:00')) {
            events.push({ ...master, event_date: today });
          }
        }
      }
    });
    events.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
    setTodayFacilityEvents(events);
  };

  const fetchNotifications = async () => {
    const notifs = [];

    // Unread messages
    try {
      const { data: participantRows } = await supabase.from('conversation_participants').select('conversation_id').eq('user_id', userId);
      const convIds = (participantRows || []).map(p => p.conversation_id);
      if (convIds.length > 0) {
        const { data: allMessages } = await supabase.from('messages').select('id, content, created_at, sender_id, users:sender_id(full_name)').in('conversation_id', convIds).neq('sender_id', userId).order('created_at', { ascending: false }).limit(10);
        const msgIds = (allMessages || []).map(m => m.id);
        let readIds = new Set();
        if (msgIds.length > 0) {
          const { data: reads } = await supabase.from('message_reads').select('message_id').eq('user_id', userId).in('message_id', msgIds);
          readIds = new Set((reads || []).map(r => r.message_id));
        }
        (allMessages || []).filter(m => !readIds.has(m.id)).slice(0, 5).forEach(m => {
          notifs.push({ id: m.id, type: 'message', text: `${m.users?.full_name || 'Someone'} sent you a message`, detail: m.content?.substring(0, 60) || '', time: m.created_at });
        });
      }
    } catch (err) { console.error('Error fetching message notifications:', err); }

    notifs.sort((a, b) => new Date(b.time) - new Date(a.time));
    setNotifications(notifs);
  };

  const fetchTrainingSessions = async () => {
    setLoadingSlots(true);
    const today = fmtLocalDate(new Date());
    const todayDow = new Date().getDay();

    const { data: slots, error: slotsError } = await supabase
      .from('training_slots')
      .select('*')
      .eq('coach_id', userId);
    if (slotsError) console.error('fetchTrainingSessions: training_slots query failed:', slotsError);

    if (!slots || slots.length === 0) { setLoadingSlots(false); return; }

    const slotExceptionMap = buildSlotExceptionMap(slots);

    const slotIds = slots.map(s => s.id);
    const { data: reservations, error: reservationsError } = await supabase
      .from('slot_reservations')
      .select('*, users:player_id(full_name, email)')
      .in('slot_id', slotIds);
    if (reservationsError) console.error('fetchTrainingSessions: slot_reservations query failed:', reservationsError);

    const allReservations = reservations || [];

    const pending = allReservations.filter(r => r.status === 'pending');
    const pendingWithSlot = pending.map(r => {
      const slot = slots.find(s => s.id === r.slot_id);
      return { ...r, slot };
    });
    setPendingRequests(pendingWithSlot);

    const todaySlots = slots.filter(slot => {
      // #292: a moved occurrence (child row, is_exception=false) is a real
      // session on its own slot_date; tombstone children (is_exception=true)
      // never render (#279).
      if (slot.recurrence_parent_id) return slot.is_exception === false && slot.slot_date === today;
      // ANY exception on today skips the series here — a tombstoned today is
      // cancelled, a moved today renders from its child row above (#292).
      if (getSlotDateException(slotExceptionMap, slot.id, today)) return false;
      if (slot.slot_date === today) return true;
      if (slot.repeat_weekly) {
        const slotDow = new Date(slot.slot_date + 'T00:00:00').getDay();
        if (slotDow === todayDow) {
          const slotStart = new Date(slot.slot_date + 'T00:00:00');
          const todayDate = new Date(today + 'T00:00:00');
          if (todayDate >= slotStart) {
            if (!slot.repeat_end_date || todayDate <= new Date(slot.repeat_end_date + 'T00:00:00')) return true;
          }
        }
      }
      return false;
    });

    const confirmed = allReservations.filter(r =>
      r.status === 'confirmed' &&
      todaySlots.some(s => s.id === r.slot_id && (r.slot_date === today || s.slot_date === today || s.repeat_weekly))
    );
    const confirmedWithSlot = confirmed.map(r => {
      const slot = todaySlots.find(s => s.id === r.slot_id);
      return { ...r, slot };
    });
    setTodaySessions(confirmedWithSlot);

    const open = todaySlots.filter(slot => {
      const slotRes = allReservations.filter(r => r.slot_id === slot.id && r.status === 'confirmed');
      return slotRes.length < (slot.max_players || 1);
    });
    setOpenSlots(open);

    setLoadingSlots(false);
  };

  const handleConfirm = async (reservationId) => {
    await supabase.from('slot_reservations').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', reservationId);
    fetchTrainingSessions();
  };

  const handleDecline = async (reservationId) => {
    await supabase.from('slot_reservations').update({ status: 'declined' }).eq('id', reservationId);
    fetchTrainingSessions();
  };

  const getNotifIcon = (type) => {
    switch (type) {
      case 'message': return <MessageSquare size={16} className="text-blue-500" />;
      case 'pending': return <Clock size={16} className="text-yellow-500" />;
      default: return <Bell size={16} className="text-green-500" />;
    }
  };

  // Build combined today's schedule from facility events + training sessions
  const todayScheduleItems = [];
  todayFacilityEvents.forEach(e => {
    todayScheduleItems.push({ id: e.id, title: e.title || 'Facility Event', time: e.start_time, type: 'facility', location: e.location });
  });
  todaySessions.forEach(s => {
    todayScheduleItems.push({ id: s.id, title: `Session: ${s.users?.full_name || 'Player'}`, time: s.slot?.start_time, type: 'training', duration: s.slot?.duration_minutes });
  });
  openSlots.forEach(s => {
    todayScheduleItems.push({ id: s.id, title: 'Open Slot', time: s.start_time, type: 'open', duration: s.duration_minutes });
  });
  todayScheduleItems.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const getTypeColor = (type) => {
    switch (type) {
      case 'facility': return 'bg-purple-100 text-purple-700';
      case 'training': return 'bg-green-100 text-green-700';
      case 'open': return 'bg-blue-100 text-blue-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-600 mt-1">Welcome to Magnus Training Platform</p>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button onClick={() => setCurrentView('coach-tools')} className="text-left p-4 bg-blue-50 rounded-lg hover:bg-blue-100 transition">
            <div className="font-medium text-blue-900">Go to Coach Tools</div>
            <div className="text-sm text-blue-600 mt-1">Add stats, schedules, and training programs</div>
          </button>
          <button onClick={() => setCurrentView('settings')} className="text-left p-4 bg-green-50 rounded-lg hover:bg-green-100 transition">
            <div className="font-medium text-green-900">Manage Users & Teams</div>
            <div className="text-sm text-green-600 mt-1">Create players, coaches, and teams</div>
          </button>
        </div>
      </div>

      {/* Pending Slot Requests */}
      {pendingRequests.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="bg-yellow-500 px-6 py-3">
            <h4 className="text-sm font-semibold text-white">Slot Requests ({pendingRequests.length})</h4>
          </div>
          <div className="divide-y divide-gray-100">
            {pendingRequests.map(req => (
              <div key={req.id} className="px-6 py-3 flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-900">{req.users?.full_name || 'Unknown'}</span>
                  <span className="text-sm text-gray-500 ml-2">
                    {req.slot?.slot_date && new Date(req.slot.slot_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {req.slot?.start_time && ` at ${formatTime(req.slot.start_time)}`}
                  </span>
                  {req.player_note && <span className="text-xs text-gray-400 ml-2">"{req.player_note}"</span>}
                </div>
                <div className="flex items-center space-x-2">
                  <button onClick={() => handleConfirm(req.id)} className="px-3 py-1 bg-green-100 text-green-700 rounded-lg text-sm font-medium hover:bg-green-200 transition">Confirm</button>
                  <button onClick={() => handleDecline(req.id)} className="px-3 py-1 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 transition">Decline</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Today's Schedule */}
        <div className="bg-white rounded-lg shadow">
          <div className="flex items-center space-x-2 p-6 pb-4 border-b border-gray-100">
            <Calendar size={20} className="text-blue-600" />
            <h3 className="text-lg font-semibold text-gray-900">Today's Schedule</h3>
          </div>
          <div className="p-6 pt-4">
            {todayScheduleItems.length > 0 ? (
              <div className="space-y-3">
                {todayScheduleItems.map((item, idx) => (
                  <div key={item.id || idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <div className="text-sm font-semibold text-gray-700 min-w-[70px]">
                        {item.time ? formatTime(item.time) : 'TBD'}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{item.title}</p>
                        {item.location && <p className="text-xs text-gray-500">{item.location}</p>}
                        {item.duration && <p className="text-xs text-gray-500">{item.duration} min</p>}
                      </div>
                    </div>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${getTypeColor(item.type)}`}>
                      {item.type}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Calendar className="mx-auto text-gray-300 mb-3" size={36} />
                <p className="text-gray-500">No events scheduled for today</p>
              </div>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="bg-white rounded-lg shadow">
          <div className="flex items-center space-x-2 p-6 pb-4 border-b border-gray-100">
            <Bell size={20} className="text-orange-500" />
            <h3 className="text-lg font-semibold text-gray-900">Notifications</h3>
            {notifications.length > 0 && (
              <span className="bg-orange-100 text-orange-700 text-xs font-medium px-2 py-0.5 rounded-full">{notifications.length}</span>
            )}
          </div>
          <div className="p-6 pt-4">
            {notifications.length > 0 ? (
              <div className="space-y-3">
                {notifications.map((notif, idx) => (
                  <div key={notif.id || idx} className="flex items-start space-x-3 p-3 bg-gray-50 rounded-lg">
                    <div className="mt-0.5">{getNotifIcon(notif.type)}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{notif.text}</p>
                      {notif.detail && <p className="text-xs text-gray-500 mt-0.5 truncate">{notif.detail}</p>}
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(notif.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at{' '}
                        {new Date(notif.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Bell className="mx-auto text-gray-300 mb-3" size={36} />
                <p className="text-gray-500">No new notifications</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity Totals */}
      <div className="bg-white rounded-lg shadow">
        <div className="flex items-center space-x-2 p-6 pb-4 border-b border-gray-100">
          <BarChart3 size={20} className="text-green-600" />
          <h3 className="text-lg font-semibold text-gray-900">Activity Totals</h3>
        </div>
        <div className="p-6 pt-4">
          {!activityTotals ? (
            <div className="text-center py-8 text-gray-500 text-sm">Loading totals...</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 pr-4 font-semibold text-gray-700"></th>
                    <th className="text-right py-2 px-3 font-semibold text-gray-700">Today</th>
                    <th className="text-right py-2 px-3 font-semibold text-gray-700">This week</th>
                    <th className="text-right py-2 pl-3 font-semibold text-gray-700">This month</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { key: 'assessments', label: 'Assessments' },
                    { key: 'lessons', label: 'Lessons' },
                    { key: 'practices', label: 'Practices' },
                    { key: 'workouts', label: 'Workouts' },
                    { key: 'games', label: 'Games' },
                  ].map(row => {
                    const t = activityTotals[row.key] || { day: 0, week: 0, month: 0 };
                    return (
                      <tr key={row.key} className="border-b border-gray-100 last:border-b-0">
                        <td className="py-2.5 pr-4 font-medium text-gray-900">{row.label}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-gray-900">{t.day}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-gray-900">{t.week}</td>
                        <td className="py-2.5 pl-3 text-right tabular-nums text-gray-900">{t.month}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

