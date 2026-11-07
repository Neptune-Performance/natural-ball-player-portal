import React, { useState } from 'react';
import {
  Briefcase, Home, Calendar, MessageSquare, DollarSign,
  FileText, Users, Map, ArrowLeftRight, Menu, X,
  Upload, CheckSquare, Megaphone, FolderOpen, ChevronDown, ChevronRight,
  ShoppingBag, UserPlus, BarChart3, Tag, Send, ListChecks, Gauge
} from 'lucide-react';
import WorkHome from './WorkHome';
import WorkDirectory from './WorkDirectory';
import WorkAdminAnnouncements from './WorkAdminAnnouncements';
import WorkDocs from './WorkDocs';
import WorkAdminDocs from './WorkAdminDocs';
import WorkMyPay from './WorkMyPay';
import WorkAdminPayroll, { PayrollPinGate } from './WorkAdminPayroll';
import WorkMyHours from './WorkMyHours';
import WorkAdminHours from './WorkAdminHours';
import WorkTimeOff from './WorkTimeOff';
import WorkAdminTimeOff from './WorkAdminTimeOff';
import WorkAdminHoursAnalytics from './WorkAdminHoursAnalytics';
import WorkSchedule from './WorkSchedule';
import WorkMessages from './WorkMessages';
import WorkInvoices from './WorkInvoices';
import WorkStore from './WorkStore';
import BulkTagSessions from './BulkTagSessions';
import Leads from './Leads';
import UsageDashboard from './UsageDashboard';
import AthleteOutreach from './AthleteOutreach';
import PlayerCardCoverage from './PlayerCardCoverage';
import NotificationBell, { deletePendingPayment, dismissEventAssignment } from './NotificationBell';
import { useMainPortalCounts, useWorkPortalCounts, dismissPtVisitNotice, markAllPtVisitNoticesSeen } from './useNotifications';

const PAGE_META = {
  'work-home':                  { title: 'Home',                   description: 'Announcements, pinned notes, and quick links for staff.' },
  'work-schedule':              { title: 'Staff Schedule',         description: 'Shifts, meetings, and the Facility view in one place.' },
  'work-messages':              { title: 'Messages',               description: 'Channels and DMs with file/image attachments and real-time updates.' },
  'work-pay-hub':               { title: 'Pay & Hours',            description: 'Your pay, invoices, hours, and time off in one place.' },
  'work-pay':                   { title: 'My Pay',                 description: 'Your paystubs and tax documents.' },
  'work-hours':                 { title: 'My Hours',               description: 'Submit and track the hours you work.' },
  'work-time-off':              { title: 'Time Off',               description: 'Request time off and check the status of your requests.' },
  'work-docs':                  { title: 'Documents',              description: 'Employee handbook, SOPs, and other staff resources.' },
  'work-directory':             { title: 'Staff Directory',        description: 'Browse the staff roster.' },
  'work-roadmap':               { title: 'Roadmap',                description: 'Plan initiatives across the team.' },
  'work-admin-finance-hub':     { title: 'Payroll',                description: 'Payroll, hours review, and time off review in one place.' },
  'work-admin-payroll':         { title: 'Payroll',                description: 'Upload paystubs and tax documents for staff.' },
  'work-admin-hours':           { title: 'Hours Review',           description: 'Approve or reject coach hour submissions.' },
  'work-admin-time-off':        { title: 'Time Off Review',        description: 'Approve or reject time off requests.' },
  'work-admin-docs':            { title: 'Manage Documents',       description: 'Upload and organize staff documents.' },
  'work-admin-announcements':   { title: 'Manage Announcements',   description: 'Post and manage announcements for staff.' },
  'work-invoices':              { title: 'My Invoices',            description: 'Submit and track your invoices.' },
  'work-admin-invoices':        { title: 'Coach Invoices',         description: 'Review and manage coach-submitted invoices.' },
  'work-admin-store':           { title: 'Store',                  description: 'Manage Square catalog, view all purchases, and decide which cancellations were sick.' },
  // #311: coach-only door into WorkStore's Bulk Tag Sessions tab, not the
  // rest of the Store (catalog/purchases/pricing stay admin-only).
  'work-bulk-tag':              { title: 'Bulk Tag Sessions',       description: 'Attach a package or plan to many training sessions at once.' },
  'work-admin-leads':           { title: 'Leads',                  description: 'Outside customers who signed up to book & pay for sessions.' },
  'work-admin-usage':           { title: 'Usage (V2 research)',    description: 'Anonymous product-usage analytics.' },
  'work-card-coverage':         { title: 'Player Card Data',       description: 'Which athletes have data for each Player Card category, and when it was last measured.' },
  'work-admin-outreach':        { title: 'Athlete Outreach',       description: 'Remind athletes to buy packages and fill open cage time.' },
};

function WorkMyFinancesHub({ userId, userRole }) {
  const [tab, setTab] = useState('pay');
  const TABS = [
    { id: 'pay',      label: 'My Pay' },
    { id: 'invoices', label: 'My Invoices' },
    { id: 'hours',    label: 'My Hours' },
    { id: 'time-off', label: 'Time Off' },
  ];
  return (
    <div>
      <div className="flex border-b border-gray-200 mb-6">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'pay'      && <WorkMyPay userId={userId} />}
      {tab === 'invoices' && <WorkInvoices userId={userId} userRole={userRole} />}
      {tab === 'hours'    && <WorkMyHours userId={userId} />}
      {tab === 'time-off' && <WorkTimeOff userId={userId} />}
    </div>
  );
}

function WorkAdminFinanceHub({ userId }) {
  const [pinVerified, setPinVerified] = useState(false);
  const [tab, setTab] = useState('payroll');
  const TABS = [
    { id: 'payroll',   label: 'Payroll' },
    { id: 'hours',     label: 'Hours Review' },
    { id: 'time-off',  label: 'Time Off Review' },
    { id: 'analytics', label: 'Hours & Time Off Chart' },
  ];
  if (!pinVerified) {
    return <PayrollPinGate onUnlock={() => setPinVerified(true)} />;
  }
  return (
    <div>
      <div className="flex border-b border-gray-200 mb-6">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t.id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'payroll'  && <WorkAdminPayroll userId={userId} defaultUnlocked={true} />}
      {tab === 'hours'    && <WorkAdminHours userId={userId} />}
      {tab === 'time-off' && <WorkAdminTimeOff userId={userId} />}
      {tab === 'analytics' && <WorkAdminHoursAnalytics />}
    </div>
  );
}

function ComingSoon({ viewKey }) {
  const meta = PAGE_META[viewKey] || { title: 'Coming Soon', description: '' };
  return (
    <div className="bg-white rounded-lg shadow p-12 text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full mb-4">
        <Briefcase size={32} />
      </div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">{meta.title}</h2>
      <p className="text-gray-600 max-w-md mx-auto">{meta.description}</p>
      <p className="text-sm text-gray-400 mt-6">Coming soon</p>
    </div>
  );
}

export default function WorkPortalShell({ userId, userRole, userName, userAvatar, onLogout, onSwitchPortal, onSwitchPortalAndView, currentView: controlledView, setCurrentView: setControlledView }) {
  const [internalView, setInternalView] = useState('work-home');
  const currentView = controlledView ?? internalView;
  const setCurrentView = setControlledView ?? setInternalView;
  const [mobileOpen, setMobileOpen] = useState(false);

  const mainCounts = useMainPortalCounts(userId, userRole);
  const workCounts = useWorkPortalCounts(userId, userRole);

  const meta = PAGE_META[currentView] || { title: 'Work Portal' };

  const handleNotifJump = (portal, view) => {
    if (portal === 'work') setCurrentView(view);
    else onSwitchPortalAndView?.(view);
  };

  // #316: shared with App.js — see deletePendingPayment in NotificationBell.js
  const handleDeletePayment = (purchaseId, productName) => deletePendingPayment(purchaseId, productName, mainCounts.refresh);

  // #402: PT notices render in this shell too (they carry the main-portal
  // tag), but there is no onOpenAthletePt here — the cross-portal jump carries
  // a view name and nothing else (onSwitchPortalAndView), so there is no way
  // to name an athlete from this side and the bell falls back to the main
  // portal's Manage Athletes list. Dismissal works identically in both shells:
  // it is one localStorage marker keyed on the signed-in user.

  const renderContent = () => {
    switch (currentView) {
      case 'work-home':
        return <WorkHome userId={userId} userRole={userRole} />;
      case 'work-directory':
        return <WorkDirectory />;
      case 'work-docs':
        return <WorkDocs />;
      case 'work-pay-hub':
      case 'work-pay':
      case 'work-hours':
      case 'work-time-off':
        return <WorkMyFinancesHub userId={userId} userRole={userRole} />;
      case 'work-schedule':
        return <WorkSchedule userId={userId} userRole={userRole} />;
      case 'work-messages':
        return <WorkMessages userId={userId} userRole={userRole} />;
      case 'work-admin-announcements':
        return userRole === 'admin' ? <WorkAdminAnnouncements userId={userId} /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-docs':
        return userRole === 'admin' ? <WorkAdminDocs userId={userId} /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-finance-hub':
        return userRole === 'admin' ? <WorkAdminFinanceHub userId={userId} /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-payroll':
        return userRole === 'admin' ? <WorkAdminPayroll userId={userId} /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-hours':
        return userRole === 'admin' ? <WorkAdminHours userId={userId} /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-time-off':
        return userRole === 'admin' ? <WorkAdminTimeOff userId={userId} /> : <ComingSoon viewKey={currentView} />;
      case 'work-invoices':
        return <WorkMyFinancesHub userId={userId} userRole={userRole} />;
      case 'work-admin-invoices':
        return userRole === 'admin' ? <WorkInvoices userId={userId} userRole={userRole} /> : <ComingSoon viewKey={currentView} />;
      // #358: coaches get in too, but WorkStore filters its own tabs by role —
      // a coach sees Purchases and Bulk Tag Sessions, not the product catalogue.
      case 'work-admin-store':
        return (userRole === 'admin' || userRole === 'coach')
          ? <WorkStore userRole={userRole} userId={userId} />
          : <ComingSoon viewKey={currentView} />;
      // #311: BulkTagSessions renders directly — it's already a standalone,
      // zero-prop component (imported into WorkStore.js, not defined there),
      // so this reaches it without pulling in WorkStore's catalog/purchases/
      // pricing tabs.
      case 'work-bulk-tag':
        return (userRole === 'coach' || userRole === 'admin') ? <BulkTagSessions /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-leads':
        return userRole === 'admin' ? <Leads /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-usage':
        return userRole === 'admin' ? <UsageDashboard /> : <ComingSoon viewKey={currentView} />;
      // #478: admin + coach (the RPC behind it is staff-gated too).
      case 'work-card-coverage':
        return (userRole === 'admin' || userRole === 'coach') ? <PlayerCardCoverage /> : <ComingSoon viewKey={currentView} />;
      case 'work-admin-outreach':
        return userRole === 'admin' ? <AthleteOutreach userId={userId} /> : <ComingSoon viewKey={currentView} />;
      default:
        return <ComingSoon viewKey={currentView} />;
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <WorkSidebar
        userRole={userRole}
        userName={userName}
        userAvatar={userAvatar}
        currentView={currentView}
        setCurrentView={(v) => { setCurrentView(v); setMobileOpen(false); }}
        onLogout={onLogout}
        onSwitchPortal={onSwitchPortal}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      />

      {/* QA 2026-08-15: `min-w-0` is load-bearing. Without it this flex item keeps
          its automatic min-content width, so every wide child (tab rows, tables,
          the hours chart) pushes the whole page sideways on a phone and the
          `overflow-x-auto` wrappers inside those children never get a constrained
          width to scroll inside. App.js:1053 has had this on the main portal all
          along; the work portal never got it. */}
      <div className="flex-1 min-w-0 md:ml-64">
        <div className="sticky top-0 z-30 bg-white border-b px-4 md:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition mr-2"
              aria-label="Open menu"
            >
              <Menu size={22} />
            </button>
            <h2 className="text-lg font-semibold text-gray-900 truncate">{meta.title}</h2>
          </div>
          <NotificationBell
            currentPortal="work"
            mainCounts={mainCounts}
            workCounts={workCounts}
            onJump={handleNotifJump}
            userRole={userRole}
            onDeletePayment={handleDeletePayment}
            onDismissEventAssignment={(eventId) => dismissEventAssignment(eventId, userId, mainCounts.refresh)}
            onDismissPtNotice={(visitId) => dismissPtVisitNotice(visitId, userId, mainCounts.refresh)}
            onDismissAllPtNotices={() => markAllPtVisitNoticesSeen(userId, mainCounts.refresh)}
          />
        </div>

        <div className="p-4 md:p-8">
          <div className="max-w-7xl mx-auto">
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkSidebar({ userRole, userName, userAvatar, currentView, setCurrentView, onLogout, onSwitchPortal, mobileOpen, setMobileOpen }) {
  const isAdmin = userRole === 'admin';
  const [adminExpanded, setAdminExpanded] = useState(true);

  const NavItem = ({ id, icon: Icon, label, matchIds }) => (
    <button
      onClick={() => setCurrentView(id)}
      className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg transition text-sm ${
        currentView === id || matchIds?.includes(currentView) ? 'bg-indigo-200 text-indigo-900' : 'hover:bg-gray-800'
      }`}
    >
      <Icon size={18} />
      <span className="flex-1 text-left">{label}</span>
    </button>
  );

  const SubNavItem = ({ id, icon: Icon, label, matchIds }) => (
    <button
      onClick={() => setCurrentView(id)}
      className={`w-full flex items-center space-x-3 px-4 py-2 rounded-lg transition text-sm ${
        currentView === id || matchIds?.includes(currentView) ? 'bg-indigo-200 text-indigo-900' : 'hover:bg-gray-800'
      }`}
    >
      <Icon size={16} />
      <span className="flex-1 text-left">{label}</span>
    </button>
  );

  return (
    <div className={`w-64 bg-gray-900 text-white h-screen fixed left-0 top-0 p-4 flex flex-col z-50 transition-transform ${
      mobileOpen ? 'translate-x-0' : '-translate-x-full'
    } md:translate-x-0`}>
      <div className="mb-4 flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <img src="/naturals-diamond.png" alt="The Naturals" className="w-8 h-8 object-contain flex-shrink-0" />
            <h1 className="text-xl font-bold text-indigo-200 truncate">NBP Work Portal</h1>
          </div>
          <div className="flex items-center space-x-3 mt-2">
            {userAvatar ? (
              <img src={userAvatar} alt="Avatar" className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div className="w-8 h-8 bg-indigo-200 rounded-full flex items-center justify-center text-indigo-900 text-xs font-bold">
                {userName?.charAt(0) || '?'}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-200 truncate">{userName || 'User'}</p>
              <p className="text-xs text-gray-400">{userRole?.toUpperCase()}</p>
            </div>
          </div>
        </div>
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden p-1 text-gray-400 hover:text-white"
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
      </div>

      <nav className="space-y-1 flex-1 overflow-y-auto -mx-2 px-2">
        <NavItem id="work-home"      icon={Home}          label="Home" />
        <NavItem id="work-schedule"  icon={Calendar}      label="Schedule" />
        <NavItem id="work-messages"  icon={MessageSquare} label="Messages" />
        {isAdmin && <SubNavItem id="work-admin-announcements" icon={Megaphone} label="Manage Announcements" />}
        <NavItem id="work-pay-hub" icon={DollarSign} label="Pay & Hours"
          matchIds={['work-pay', 'work-invoices', 'work-hours', 'work-time-off']} />
        <NavItem id="work-docs"      icon={FileText}      label="Documents" />
        <NavItem id="work-directory" icon={Users}         label="Directory" />
        <NavItem id="work-roadmap"   icon={Map}           label="Roadmap" />
        {/* #478: every staff member, one path for both roles. */}
        <NavItem id="work-card-coverage" icon={Gauge} label="Player Card Data" />
        {/* #311: coach-only — admins already reach this via Admin > Store's
            Bulk Tag Sessions tab, so this stays out of their nav to avoid a
            second, redundant path to the same tool. */}
        {userRole === 'coach' && (
          <NavItem id="work-bulk-tag" icon={Tag} label="Bulk Tag Sessions" />
        )}
        {/* #358: coach-only door to the Purchases tab, so a coach can settle a
            purchase that was paid in Square or in person. Same pattern as
            Bulk Tag Sessions above. Admins reach it under Admin > Store, which
            is why this stays out of their nav — one path each, no duplicates.
            WorkStore hides the Catalog/Packages/Backfill/Duplicates tabs from
            coaches, so this opens on Purchases and shows nothing else they
            should not have.
            #306: a coach now also gets the Cancellations tab through this same
            door, because Cordell put the sick-cancel decision with admins AND
            coaches. The label stays "Purchases" — it is the tab this opens on,
            and a second sidebar entry pointing at the same screen is the
            duplicate path the note above exists to avoid. */}
        {userRole === 'coach' && (
          <NavItem id="work-admin-store" icon={ListChecks} label="Purchases" />
        )}

        {isAdmin && (
          <div className="pt-2">
            <button
              onClick={() => setAdminExpanded(!adminExpanded)}
              className="w-full flex items-center space-x-3 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400 hover:text-white transition"
            >
              <span className="flex-1 text-left">Admin</span>
              {adminExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {adminExpanded && (
              <div className="space-y-1 mt-1">
                <SubNavItem id="work-admin-finance-hub" icon={Upload} label="Payroll"
                  matchIds={['work-admin-payroll', 'work-admin-hours', 'work-admin-time-off']} />
                <SubNavItem id="work-admin-docs"           icon={FolderOpen}  label="Manage Documents" />
                <SubNavItem id="work-admin-invoices"       icon={DollarSign}  label="Coach Invoices" />
                <SubNavItem id="work-admin-store"          icon={ShoppingBag} label="Store" />
                <SubNavItem id="work-admin-leads"          icon={UserPlus}    label="Leads" />
                <SubNavItem id="work-admin-outreach"       icon={Send}        label="Athlete Outreach" />
                <SubNavItem id="work-admin-usage"          icon={BarChart3}   label="Usage (V2 research)" />
              </div>
            )}
          </div>
        )}
      </nav>

      <div className="mt-auto pt-3 space-y-1.5">
        <button
          onClick={onSwitchPortal}
          className="w-full flex items-center justify-center space-x-2 bg-indigo-200 text-indigo-900 px-3 py-2 rounded-lg hover:bg-indigo-300 transition text-sm"
        >
          <ArrowLeftRight size={16} />
          <span>Switch to Main Portal</span>
        </button>
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
