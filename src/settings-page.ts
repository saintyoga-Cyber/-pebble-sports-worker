// Server-hosted Pebble settings page.
//
// Replaces the previous Clay-based settings flow. The Core Devices
// iPhone app cannot render the ~127KB base64 data: URI that Clay
// generates, so we serve a real HTTPS HTML page instead.
//
// The page reads the current sport and followed-team IDs from query
// params, fetches the available teams for that sport from
// /api/sports/teams?sport=<sport>, and lets the user pick. On save
// it navigates back to ?return_to with the settings payload appended
// after the # — the watchapp's webviewclosed handler parses that
// payload as JSON.

export function renderSettingsPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>Sports Simplified Settings</title>
  <style>
    :root {
      --bg: #f4f4f4;
      --card: #ffffff;
      --header: #0f1f33;
      --header-text: #ffffff;
      --text: #1a1a1a;
      --muted: #6b7280;
      --border: #d1d5db;
      --accent: #2a72d6;
      --accent-text: #ffffff;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-text-size-adjust: 100%; }
    header { background: var(--header); color: var(--header-text); padding: 18px 16px; text-align: center; }
    header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    header p { margin: 6px 0 0; font-size: 13px; opacity: 0.8; }
    main { padding: 16px; max-width: 640px; margin: 0 auto; }
    section { background: var(--card); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    section h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    label.row { display: block; margin-bottom: 8px; }
    .field { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    select, input[type="text"] {
      width: 100%; padding: 12px 12px; font-size: 16px;
      border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--text);
      -webkit-appearance: none; appearance: none;
    }
    select { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%236b7280' d='M0 0l6 8 6-8z'/></svg>"); background-repeat: no-repeat; background-position: right 14px center; padding-right: 32px; }
    .team-row { display: flex; align-items: center; padding: 10px 4px; border-bottom: 1px solid #eef0f3; cursor: pointer; }
    .team-row:last-child { border-bottom: none; }
    .team-row input[type="checkbox"] { width: 20px; height: 20px; margin: 0 12px 0 0; flex-shrink: 0; }
    .team-row .logo { width: 28px; height: 28px; object-fit: contain; margin-right: 10px; flex-shrink: 0; background: transparent; }
    .team-row .label { font-size: 16px; }
    .team-row .abbr { color: var(--muted); font-size: 14px; margin-left: 6px; }
    .team-row.hidden { display: none; }
    #teamList { max-height: 50vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    #teamListEmpty { color: var(--muted); font-size: 14px; text-align: center; padding: 20px 0; }
    button.primary {
      display: block; width: 100%; padding: 14px;
      background: var(--accent); color: var(--accent-text);
      border: none; border-radius: 10px; font-size: 17px; font-weight: 600;
      cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    button.primary:active { opacity: 0.85; }
    .footnote { font-size: 12px; color: var(--muted); text-align: center; margin: 12px 0 0; }
  </style>
</head>
<body>
  <header>
    <h1>Sports Simplified</h1>
    <p>Pick a sport and the teams you want to follow.</p>
  </header>
  <main>
    <section>
      <h2>Sport</h2>
      <label class="row">
        <div class="field">Active sport</div>
        <select id="sportSelect">
          <option value="nhl">NHL Hockey</option>
          <option value="nba">NBA Basketball</option>
          <option value="mlb">MLB Baseball</option>
          <option value="nfl">NFL Football</option>
          <option value="fifa-wc">FIFA World Cup</option>
        </select>
      </label>
    </section>

    <section>
      <h2 id="teamsHeading">Followed Teams</h2>
      <label class="row">
        <div class="field">Search</div>
        <input type="text" id="teamSearch" placeholder="Filter teams\u2026" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      </label>
      <div id="teamList"></div>
      <div id="teamListEmpty" style="display:none;">Loading teams\u2026</div>
    </section>

    <button id="save" class="primary">Save Settings</button>
    <p class="footnote">Settings will sync to your watch when you tap Save.</p>
  </main>

  <script>
  (function () {
    function getQueryParam(name) {
      var match = window.location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
      return match ? decodeURIComponent(match[1].replace(/\\+/g, ' ')) : '';
    }

    var initialSport = getQueryParam('sport') || 'nhl';
    var initialTeamsCsv = getQueryParam('teams') || '';
    var initialFollowedRaw = getQueryParam('followed') || '';
    var returnTo = getQueryParam('return_to') || 'pebblejs://close#';
    // If a Pebble client passed return_to with an unencoded '#' (e.g.
    // ?return_to=pebblejs://close#), the browser treats '#' as the URL
    // fragment delimiter and strips it before it reaches getQueryParam,
    // so we'd end up appending the JSON payload directly to
    // 'pebblejs://close' with no '#' separator. Restore the trailing
    // '#' so the watchapp's webviewclosed e.response (everything after
    // the '#') is the URL-encoded JSON payload as intended.
    if (returnTo.indexOf('#') === -1) returnTo = returnTo + '#';

    // followedAll holds the watch's full multi-sport followed map,
    // e.g. { "nhl": ["10"], "fifa-wc": ["CAN"] }, so we can pre-check
    // the right teams for whichever sport the dropdown shows. The
    // legacy ?teams=<csv> param is the single-sport fallback for
    // direct URL visits or older watch builds that haven't been
    // upgraded to the multi-sport storage yet.
    var followedAll = {};
    if (initialFollowedRaw) {
      try {
        var parsedFollowed = JSON.parse(initialFollowedRaw);
        if (parsedFollowed && typeof parsedFollowed === 'object' && !Array.isArray(parsedFollowed)) {
          followedAll = parsedFollowed;
        }
      } catch (e) {
        // Malformed followed param — fall back to CSV / empty selection.
      }
    }

    function seedSelectedIdsForSport(sport) {
      var ids = {};
      var fromFollowed = followedAll[sport];
      if (Array.isArray(fromFollowed)) {
        fromFollowed.forEach(function (id) {
          if (id) ids[id] = true;
        });
      } else if (sport === initialSport && initialTeamsCsv) {
        // Backward-compat path: only the legacy ?teams= csv was sent
        // (old watch build, or a debug URL). Use it for the initial
        // sport's selection so existing single-sport users still see
        // their pre-checked teams while the watch upgrades.
        initialTeamsCsv.split(',').forEach(function (raw) {
          var id = raw.trim();
          if (id) ids[id] = true;
        });
      }
      return ids;
    }

    var sportSelect = document.getElementById('sportSelect');
    var searchInput = document.getElementById('teamSearch');
    var teamList = document.getElementById('teamList');
    var teamListEmpty = document.getElementById('teamListEmpty');
    var teamsHeading = document.getElementById('teamsHeading');
    var saveButton = document.getElementById('save');

    sportSelect.value = initialSport;
    updateLabelsForSport(initialSport);

    // selectedIds is the source of truth for which teams are checked.
    // We keep it independent of DOM state so it survives re-rendering
    // (e.g. when the user switches sport or types in the search box).
    var selectedIds = seedSelectedIdsForSport(initialSport);

    // allTeams is the full team list for the current sport; we render
    // checkboxes from this list and filter client-side via .hidden.
    var allTeams = [];

    function updateLabelsForSport(sport) {
      var isFifa = sport === 'fifa-wc';
      teamsHeading.textContent = isFifa ? 'Followed Countries' : 'Followed Teams';
      searchInput.placeholder = isFifa ? 'Filter countries\u2026' : 'Filter teams\u2026';
    }

    function renderTeams() {
      teamList.innerHTML = '';
      if (allTeams.length === 0) {
        teamListEmpty.textContent = 'No teams available.';
        teamListEmpty.style.display = 'block';
        return;
      }
      teamListEmpty.style.display = 'none';
      var frag = document.createDocumentFragment();
      allTeams.forEach(function (team) {
        var displayName = team.displayName || team.name || '';
        var shortName = team.shortDisplayName || '';
        var abbr = team.abbreviation || '';
        var logoHref = team.logoHref || '';

        var row = document.createElement('label');
        row.className = 'team-row';
        row.setAttribute('data-team-id', team.id);
        row.setAttribute('data-search', (displayName + ' ' + shortName + ' ' + abbr).toLowerCase());

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = team.id;
        cb.checked = !!selectedIds[team.id];
        cb.addEventListener('change', function () {
          if (cb.checked) selectedIds[team.id] = true;
          else delete selectedIds[team.id];
        });

        row.appendChild(cb);

        if (logoHref) {
          var img = document.createElement('img');
          img.className = 'logo';
          img.src = logoHref;
          img.alt = '';
          img.loading = 'lazy';
          row.appendChild(img);
        }

        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = displayName;
        row.appendChild(label);

        if (abbr) {
          var abbrEl = document.createElement('span');
          abbrEl.className = 'abbr';
          abbrEl.textContent = '(' + abbr + ')';
          row.appendChild(abbrEl);
        }

        frag.appendChild(row);
      });
      teamList.appendChild(frag);
      applyFilter();
    }

    function applyFilter() {
      var q = (searchInput.value || '').toLowerCase().trim();
      var rows = teamList.querySelectorAll('.team-row');
      for (var i = 0; i < rows.length; i++) {
        var hay = rows[i].getAttribute('data-search') || '';
        if (!q || hay.indexOf(q) !== -1) rows[i].classList.remove('hidden');
        else rows[i].classList.add('hidden');
      }
    }

    function loadTeams(sport) {
      teamListEmpty.textContent = 'Loading teams\u2026';
      teamListEmpty.style.display = 'block';
      teamList.innerHTML = '';

      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/sports/teams?sport=' + encodeURIComponent(sport), true);
      xhr.timeout = 10000;
      xhr.ontimeout = function () {
        teamListEmpty.textContent = 'Could not load teams (timeout). Tap Save to keep current selection.';
      };
      xhr.onerror = function () {
        teamListEmpty.textContent = 'Could not load teams (network error).';
      };
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          teamListEmpty.textContent = 'Could not load teams (HTTP ' + xhr.status + ').';
          return;
        }
        var data;
        try { data = JSON.parse(xhr.responseText); } catch (e) {
          teamListEmpty.textContent = 'Could not parse teams response.';
          return;
        }
        if (!Array.isArray(data)) {
          teamListEmpty.textContent = 'Unexpected teams response.';
          return;
        }
        allTeams = data;
        renderTeams();
      };
      xhr.send();
    }

    sportSelect.addEventListener('change', function () {
      var newSport = sportSelect.value;
      // Stash the current sport's in-progress selections back into
      // followedAll before switching, so unsaved checkbox edits
      // survive a round-trip through the dropdown (e.g. user picks
      // teams in NHL, peeks at FIFA-WC, then comes back). Without
      // this, seedSelectedIdsForSport would overwrite from the
      // saved-on-watch state and silently drop the user's edits.
      followedAll[sportSelect.dataset.lastSport || initialSport] = Object.keys(selectedIds);
      sportSelect.dataset.lastSport = newSport;

      updateLabelsForSport(newSport);
      // Sport changed — re-seed selections from the multi-sport
      // followed map so this sport's previously saved (or in-session
      // stashed) teams appear pre-checked. Other sports' selections
      // stay intact in followedAll for when the user switches back.
      selectedIds = seedSelectedIdsForSport(newSport);
      loadTeams(newSport);
    });

    searchInput.addEventListener('input', applyFilter);

    saveButton.addEventListener('click', function () {
      var payload = {
        SPORT: sportSelect.value,
        TEAMS: Object.keys(selectedIds)
      };
      document.location = returnTo + encodeURIComponent(JSON.stringify(payload));
    });

    // Initial load.
    loadTeams(initialSport);
  })();
  </script>
</body>
</html>
`;
}
