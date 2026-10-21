import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { readAllPages } from './readAllPages';
import { Dumbbell, Utensils, Zap, Target, FolderOpen, Wand2, Sparkles, Link2, AlertTriangle, Video } from 'lucide-react';
import { TrainingTab, MealsTab } from './CoachTools';
import ProgramGenerator from './ProgramGenerator';
import ThrowingGenerator from './ThrowingGenerator';
import HittingGenerator from './HittingGenerator';
import NutritionGenerator from './NutritionGenerator';
import AutoProgram from './AutoProgram';
import ExerciseVideoGaps from './ExerciseVideoGaps';
import ExerciseVideoLibrary from './ExerciseVideoLibrary';

/* --------------------------------------------------------------------------- *
 *  Programming — unified staff hub for training/meal libraries + the generators.
 *
 *  Two top-level views:
 *    • Programs  — the Training Programs & Meal Plans libraries (moved out of
 *                  Coach Tools; TrainingTab / MealsTab are shared components).
 *    • Generate  — Auto-Program (all four domains for one athlete in one pass,
 *                  #174) plus the four individual assessment/data-driven
 *                  generators (S&C, Throwing, Hitting, Nutrition).
 *    • Videos    — Missing videos: the exercise-video gap report (#170), every
 *                  exercise with no video link + the best library match.
 *                  All videos (#459): the whole library, with a Replace that
 *                  rewrites every copy of the link (ExerciseVideoLibrary.js).
 * --------------------------------------------------------------------------- */

export default function Programming({ userId, userRole }) {
  const [teams, setTeams] = useState([]);
  const [players, setPlayers] = useState([]);

  const [view, setView] = useState('programs'); // 'programs' | 'generate'
  const [programsTab, setProgramsTab] = useState('training'); // 'training' | 'meals'
  const [genTab, setGenTab] = useState('auto'); // 'auto' | 'sc' | 'throwing' | 'hitting' | 'nutrition'
  const [videosTab, setVideosTab] = useState('missing'); // 'missing' | 'all' (#459)

  // Teams + players power the Training/Meal library tabs (mirrors CoachTools).
  const [loadError, setLoadError] = useState('');

  // Always destructure `error`. A failed query here used to look identical to
  // an empty facility, which is how a broken screen ran for two days.
  useEffect(() => {
    (async () => {
      const { data: t, error: tErr } = await supabase.from('teams').select('*').order('name');
      if (tErr) { setLoadError(`Could not load teams: ${tErr.message}`); return; }
      setTeams(t || []);
      // #437: paged past the 1,000-row clamp.
      const { rows: p, error: pErr } = await readAllPages(() => supabase
        .from('users')
        .select('id, full_name, email, player_profiles!player_profiles_user_id_fkey(position, jersey_number, level), team_members(team_id, teams(name))')
        .or('role.eq.player,role.eq.coach,role.eq.admin,secondary_role.eq.player')
        .order('full_name')
        .order('id'));
      if (pErr) { setLoadError(`Could not load athletes: ${pErr.message}`); return; }
      setPlayers(p);
      setLoadError('');
    })();
  }, []);

  const videosSubTabs = [
    { key: 'missing', icon: AlertTriangle, label: 'Missing videos' },
    { key: 'all', icon: Video, label: 'All videos' },
  ];

  const programsSubTabs = [
    { key: 'training', icon: Dumbbell, label: 'Training Programs' },
    { key: 'meals', icon: Utensils, label: 'Meal Plans' },
  ];
  const genSubTabs = [
    { key: 'auto', icon: Sparkles, label: 'Auto-Program' },
    { key: 'sc', icon: Dumbbell, label: 'S&C' },
    { key: 'throwing', icon: Zap, label: 'Throwing' },
    { key: 'hitting', icon: Target, label: 'Hitting' },
    { key: 'nutrition', icon: Utensils, label: 'Nutrition' },
  ];

  const viewBtn = (key, icon, label) => {
    const Icon = icon;
    const active = view === key;
    return (
      <button
        key={key}
        onClick={() => setView(key)}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition whitespace-nowrap flex-shrink-0 ${
          active ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
        }`}
      >
        <Icon size={16} />{label}
      </button>
    );
  };

  const subTab = (tab, current, setter) => (
    <button
      key={tab.key}
      onClick={() => setter(tab.key)}
      className={`py-3 px-1 border-b-2 font-medium text-sm transition whitespace-nowrap ${
        current === tab.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      <tab.icon size={16} className="inline mr-2" />{tab.label}
    </button>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-gray-900">Programming</h2>
        <p className="text-gray-600 mt-1">Training &amp; meal-plan libraries and the assessment-driven generators.</p>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError} — the lists below may be incomplete. Reload the page to try again.
        </div>
      )}

      {/* View toggle: Programs | Generate | Videos */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mb-1">
        {viewBtn('programs', FolderOpen, 'Programs')}
        {viewBtn('generate', Wand2, 'Generate')}
        {viewBtn('videos', Link2, 'Videos')}
      </div>

      {view === 'programs' && (
        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-8 px-6 overflow-x-auto">
              {programsSubTabs.map((tab) => subTab(tab, programsTab, setProgramsTab))}
            </nav>
          </div>
          <div className="p-6">
            {programsTab === 'training' && <TrainingTab teams={teams} players={players} />}
            {programsTab === 'meals' && <MealsTab teams={teams} players={players} />}
          </div>
        </div>
      )}

      {view === 'generate' && (
        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-8 px-6 overflow-x-auto">
              {genSubTabs.map((tab) => subTab(tab, genTab, setGenTab))}
            </nav>
          </div>
          <div>
            {genTab === 'auto' && <AutoProgram userId={userId} userRole={userRole} />}
            {genTab === 'sc' && <ProgramGenerator userId={userId} userRole={userRole} />}
            {genTab === 'throwing' && <ThrowingGenerator userId={userId} userRole={userRole} />}
            {genTab === 'hitting' && <HittingGenerator userId={userId} userRole={userRole} />}
            {genTab === 'nutrition' && <NutritionGenerator userId={userId} userRole={userRole} />}
          </div>
        </div>
      )}

      {view === 'videos' && (
        <div className="bg-white rounded-lg shadow">
          <div className="border-b border-gray-200">
            <nav className="flex space-x-8 px-6 overflow-x-auto">
              {videosSubTabs.map((tab) => subTab(tab, videosTab, setVideosTab))}
            </nav>
          </div>
          <div className="p-6">
            {videosTab === 'missing' && <ExerciseVideoGaps userId={userId} userRole={userRole} />}
            {videosTab === 'all' && <ExerciseVideoLibrary />}
          </div>
        </div>
      )}
    </div>
  );
}
