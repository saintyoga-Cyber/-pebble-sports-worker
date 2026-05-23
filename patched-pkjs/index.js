var timeline = require('./timeline');

var COMPANION_URL = 'https://pebble-sports-worker.saintyoga.workers.dev';
var POLL_INTERVAL_MS = 2 * 60 * 1000;

var LS_FOLLOWED = 'sports_followed';
var LS_ACTIVE_SPORT = 'sports_active_sport';
var LS_SPORT_LEGACY = 'sports_selected_sport';
var LS_TEAMS_LEGACY = 'sports_followed_teams';

function clearLegacyKeys() {
  try { localStorage.removeItem(LS_SPORT_LEGACY); } catch (e1) {}
  try { localStorage.removeItem(LS_TEAMS_LEGACY); } catch (e2) {}
}

function getSavedFollowed() {
  try {
    var raw = localStorage.getItem(LS_FOLLOWED);
    if (raw) {
      var parsed;
      try { parsed = JSON.parse(raw); } catch (eParse) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      try { localStorage.removeItem(LS_FOLLOWED); } catch (eClear) {}
      console.log('sports: LS_FOLLOWED corrupted — discarded');
    }
    var oldSport = localStorage.getItem(LS_SPORT_LEGACY);
    var oldTeamsRaw = localStorage.getItem(LS_TEAMS_LEGACY);
    if (oldSport || oldTeamsRaw) {
      var migrated = {};
      var migratedOk = false;
      if (oldSport && oldTeamsRaw) {
        try {
          var oldTeams = JSON.parse(oldTeamsRaw);
          if (Array.isArray(oldTeams)) {
            migrated[oldSport] = oldTeams;
            migratedOk = true;
          }
        } catch (eOld) {}
      }
      try { localStorage.setItem(LS_FOLLOWED, JSON.stringify(migrated)); } catch (e1) {}
      if (migratedOk) {
        try { localStorage.setItem(LS_ACTIVE_SPORT, oldSport); } catch (e2) {}
        console.log('sports: migrated legacy settings to multi-sport followed map');
      } else {
        console.log('sports: legacy settings malformed — discarded');
      }
      clearLegacyKeys();
      return migrated;
    }
    return {};
  } catch (e) {
    return {};
  }
}

function getSavedSport() {
  try {
    getSavedFollowed();
    return localStorage.getItem(LS_ACTIVE_SPORT) || '';
  } catch (e) {
    return '';
  }
}

function getSavedTeamIds() {
  var followed = getSavedFollowed();
  var sport = getSavedSport();
  if (!sport) return [];
  var teams = followed[sport];
  return Array.isArray(teams) ? teams : [];
}

var pollTimer = null;
var isPollingActive = false;
var activeGameIds = {};
var pushedFinalIds = {};
var pushedScheduledIds = {};
var SCHEDULED_WINDOW_MS = 48 * 60 * 60 * 1000;

function buildSnapshotQuery() {
  var sport = getSavedSport();
  var teams = getSavedTeamIds();
  var params = [];
  if (sport) params.push('sport=' + encodeURIComponent(sport));
  if (teams.length > 0) params.push('teams=' + encodeURIComponent(teams.join(',')));
  return params.length > 0 ? '?' + params.join('&') : '';
}

function fetchSnapshot(cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', COMPANION_URL + '/api/sports/games' + buildSnapshotQuery(), true);
  xhr.timeout = 10000;
  xhr.ontimeout = function() { cb(new Error('snapshot timeout'), []); };
  xhr.onload = function() {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        cb(null, (data && data.games) || []);
      } catch (e) {
        cb(e, []);
      }
    } else {
      cb(new Error('snapshot status ' + xhr.status), []);
    }
  };
  xhr.onerror = function() { cb(new Error('snapshot network error'), []); };
  xhr.send();
}

function teamLabel(team) {
  if (!team) return '';
  var label = team.abbreviation || team.shortDisplayName || team.displayName || '';
  return label.substring(0, 4);
}

function formatStartTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function buildSubtitle(game) {
  if (game.state === 'final')     return 'Final';
  if (game.state === 'postponed') return 'Postponed';
  if (game.state === 'canceled')  return 'Canceled';
  if (game.state === 'pre-game' || game.state === 'scheduled') {
    var startMs = new Date(game.startTime).getTime();
    var diffMs = startMs - Date.now();
    if (!isNaN(diffMs) && diffMs > 0) {
      var totalMin = Math.round(diffMs / 60000);
      var hh = Math.floor(totalMin / 60);
      var mm = totalMin % 60;
      if (hh > 0) return mm > 0 ? 'Starts in ' + hh + 'h ' + mm + 'm'
                                : 'Starts in ' + hh + 'h';
      return 'Starts in ' + mm + 'm';
    }
    return formatStartTime(game.startTime);
  }
  if (game.state === 'in-game') {
    var bits = [];
    if (game.period) bits.push(game.period);
    if (game.clock)  bits.push(game.clock);
    return bits.length ? bits.join(' ') : 'In Progress';
  }
  return '';
}

function buildName(game) {
  var away = teamLabel(game.awayTeam);
  var home = teamLabel(game.homeTeam);
  return away + ' @ ' + home;
}

function sportIcon() {
  var sport = getSavedSport();
  if (sport === 'nhl')      return 'system://images/HOCKEY_GAME';
  if (sport === 'fifa-wc')  return 'system://images/SOCCER_GAME';
  if (sport === 'nba')      return 'system://images/BASKETBALL_GAME';
  if (sport === 'nfl')      return 'system://images/AMERICAN_FOOTBALL';
  if (sport === 'mlb')      return 'system://images/BASEBALL_GAME';
  return 'system://images/SCHEDULED_EVENT';
}

var NHL_TEAM_COLORS = {
  ANA: 'orange', ARI: 'darkCandyAppleRed', BOS: 'yellow', BUF: 'blue',
  CAR: 'red', CBJ: 'blue', CGY: 'red', CHI: 'red', COL: 'darkCandyAppleRed',
  DAL: 'darkGreen', DET: 'red', EDM: 'orange', FLA: 'red', LAK: 'darkGray',
  MIN: 'darkGreen', MTL: 'red', NJD: 'red', NSH: 'yellow', NYI: 'blue',
  NYR: 'blue', OTT: 'red', PHI: 'orange', PIT: 'yellow', SEA: 'darkBlue',
  SJS: 'darkBlue', STL: 'blue', TBL: 'blue', TOR: 'blue', UTA: 'darkBlue',
  VAN: 'blue', VGK: 'yellow', WPG: 'blue', WSH: 'red'
};

var NBA_TEAM_COLORS = {
  ATL: 'red', BOS: 'darkGreen', BKN: 'darkGray', CHA: 'purple', CHI: 'red',
  CLE: 'darkCandyAppleRed', DAL: 'blue', DEN: 'darkBlue', DET: 'red',
  GSW: 'blue', GS: 'blue', HOU: 'red', IND: 'darkBlue', LAC: 'red',
  LAL: 'purple', MEM: 'darkBlue', MIA: 'red', MIL: 'darkGreen',
  MIN: 'darkBlue', NOP: 'darkBlue', NO: 'darkBlue', NYK: 'blue', NY: 'blue',
  OKC: 'blue', ORL: 'blue', PHI: 'blue', PHX: 'purple', PHO: 'purple',
  POR: 'red', SAC: 'purple', SAS: 'darkGray', SA: 'darkGray', TOR: 'red',
  UTAH: 'darkGreen', UTA: 'darkGreen', WSH: 'blue', WAS: 'blue'
};

var MLB_TEAM_COLORS = {
  ARI: 'darkCandyAppleRed', ATL: 'red', BAL: 'orange', BOS: 'red',
  CHC: 'blue', CHW: 'darkGray', CWS: 'darkGray', CIN: 'red', CLE: 'red',
  COL: 'purple', DET: 'darkBlue', HOU: 'orange', KC: 'blue', KAN: 'blue',
  LAA: 'red', LAD: 'blue', MIA: 'blue', MIL: 'darkBlue', MIN: 'darkBlue',
  NYM: 'blue', NYY: 'darkBlue', OAK: 'darkGreen', PHI: 'red', PIT: 'yellow',
  SD: 'yellow', SDP: 'yellow', SF: 'orange', SFG: 'orange', SEA: 'darkGreen',
  STL: 'red', TB: 'darkBlue', TBR: 'darkBlue', TEX: 'blue', TOR: 'blue',
  WSH: 'red', WAS: 'red'
};

var NFL_TEAM_COLORS = {
  ARI: 'red', ATL: 'red', BAL: 'purple', BUF: 'blue', CAR: 'blue',
  CHI: 'darkBlue', CIN: 'orange', CLE: 'orange', DAL: 'blue', DEN: 'orange',
  DET: 'blue', GB: 'darkGreen', HOU: 'darkBlue', IND: 'blue', JAX: 'darkBlue',
  KC: 'red', LAC: 'blue', LAR: 'blue', LV: 'darkGray', OAK: 'darkGray',
  MIA: 'blue', MIN: 'purple', NE: 'darkBlue', NO: 'yellow', NYG: 'blue',
  NYJ: 'darkGreen', PHI: 'darkGreen', PIT: 'yellow', SEA: 'darkBlue',
  SF: 'red', TB: 'red', TEN: 'darkBlue', WSH: 'darkCandyAppleRed',
  WAS: 'darkCandyAppleRed'
};

function teamColor(team) {
  if (!team) return 'white';
  var sport = getSavedSport();
  var map;
  if (sport === 'nba') map = NBA_TEAM_COLORS;
  else if (sport === 'mlb') map = MLB_TEAM_COLORS;
  else if (sport === 'nfl') map = NFL_TEAM_COLORS;
  else map = NHL_TEAM_COLORS;
  var abbr = (team.abbreviation || '').toUpperCase();
  return map[abbr] || 'white';
}

function createSportsPin(game) {
  var awayAbbr = teamLabel(game.awayTeam);
  var homeAbbr = teamLabel(game.homeTeam);
  var isScoreState = game.state === 'in-game' ||
                     game.state === 'final';
  var rankAway = game.awayTeam && game.awayTeam.rank
                   ? String(game.awayTeam.rank).substring(0, 2) : '';
  var rankHome = game.homeTeam && game.homeTeam.rank
                   ? String(game.homeTeam.rank).substring(0, 2) : '';
  var recordAway = game.awayTeam && game.awayTeam.record
                     ? game.awayTeam.record : '';
  var recordHome = game.homeTeam && game.homeTeam.record
                     ? game.homeTeam.record : '';
  var subtitle = buildSubtitle(game);
  var matchup = awayAbbr + ' @ ' + homeAbbr;

  // Title and body are the only fields the Core Devices phone app forwards
  // to the watch today, so they carry all visible info. Keep sports-* fields
  // populated for forward compat.
  var title;
  var bodyLines;
  if (isScoreState) {
    title = awayAbbr + ' ' + game.awayScore + ' \u2014 ' +
            homeAbbr + ' ' + game.homeScore;
    bodyLines = [matchup];
    if (game.period || game.clock) {
      bodyLines.push([game.period, game.clock].filter(Boolean).join(' '));
    }
  } else {
    title = matchup;
    bodyLines = [];
    if (recordAway || recordHome) {
      bodyLines.push(awayAbbr + ' ' + recordAway + ' \u00b7 ' +
                     homeAbbr + ' ' + recordHome);
    }
  }
  var body = bodyLines.join('\n') || subtitle;
  var paragraphs = isScoreState
    ? [String(game.awayScore), String(game.homeScore)]
    : [recordAway || '\u2014', recordHome || '\u2014'];

  var layout = {
    type: 'sportsPin',
    title: title,
    subtitle: subtitle,
    body: body,
    tinyIcon: sportIcon(),
    largeIcon: sportIcon(),
    lastUpdated: game.lastUpdated || new Date().toISOString(),
    primaryColor: teamColor(game.homeTeam),
    backgroundColor: teamColor(game.awayTeam),
    headings: [awayAbbr, homeAbbr],
    paragraphs: paragraphs,
    nameAway: awayAbbr,
    nameHome: homeAbbr,
    rankAway: rankAway,
    rankHome: rankHome,
    recordAway: recordAway,
    recordHome: recordHome,
    scoreAway: isScoreState ? String(game.awayScore) : '',
    scoreHome: isScoreState ? String(game.homeScore) : '',
    sportsGameState: isScoreState ? 'in-game' : 'pre-game'
  };
  var pin = {
    id: 'sports-' + game.gameId + (isScoreState ? '-live' : '-pre'),
    time: game.startTime,
    layout: layout
  };
  if (isScoreState) {
    pin.updateNotification = {
      layout: {
        type: 'genericNotification',
        title: title,
        body: subtitle,
        tinyIcon: sportIcon()
      }
    };
  }
  return pin;
}

function pushPin(game, label) {
  var pin = createSportsPin(game);
  if (game.state === 'in-game' || game.state === 'final') {
    timeline.deleteUserPin({id: 'sports-' + game.gameId + '-pre'}, function() {});
  }
  console.log('sports: PUT pin ' + pin.id + ' [' + label + '] ' +
    pin.layout.nameAway + ' ' + pin.layout.scoreAway + ' - ' +
    pin.layout.scoreHome + ' ' + pin.layout.nameHome +
    ' (' + pin.layout.subtitle + ')');
  timeline.insertUserPin(pin, function(responseText, status) {
    console.log('sports: pin ' + pin.id + ' status=' + status);
    if (status === 401 || status === 410) {
      console.log('sports: pin ' + pin.id + ' auth rejected (' + status +
        '), next tick will refetch timeline token');
      return;
    }
    if (status < 200 || status >= 300) {
      console.log('sports: pin ' + pin.id + ' failed: ' + responseText);
    }
  });
}

function tick() {
  if (!isPollingActive) {
    console.log('sports: tick aborted (polling inactive)');
    return;
  }
  fetchSnapshot(function(err, games) {
    if (!isPollingActive) {
      console.log('sports: snapshot returned after stop — discarding');
      return;
    }
    if (err) {
      console.log('sports: fetch failed: ' + err.message);
      scheduleNext(true);
      return;
    }

    var stillLive = false;

    for (var i = 0; i < games.length; i++) {
      var game = games[i];
      if (!game || !game.gameId) continue;

      if (game.state === 'in-game') {
        activeGameIds[game.gameId] = true;
        delete pushedFinalIds[game.gameId];
        delete pushedScheduledIds[game.gameId];
        pushPin(game, 'live');
        stillLive = true;
      } else if (game.state === 'pre-game' || game.state === 'scheduled') {
        if (!pushedScheduledIds[game.gameId]) {
          var startMs = game.startTime ? new Date(game.startTime).getTime() : NaN;
          if (!isNaN(startMs)) {
            var diffMs = startMs - Date.now();
            if (diffMs >= 0 && diffMs <= SCHEDULED_WINDOW_MS) {
              pushPin(game, 'scheduled');
              pushedScheduledIds[game.gameId] = true;
            }
          }
        }
      } else if (game.state === 'final' || game.state === 'postponed' ||
                 game.state === 'canceled') {
        if (!pushedFinalIds[game.gameId]) {
          var endMs = game.lastUpdated ? new Date(game.lastUpdated).getTime() : NaN;
          var age = isNaN(endMs) ? 0 : (Date.now() - endMs);
          var FINAL_WINDOW_MS = 24 * 60 * 60 * 1000;
          if (isNaN(endMs) || age <= FINAL_WINDOW_MS) {
            pushPin(game, game.state);
            pushedFinalIds[game.gameId] = true;
            delete activeGameIds[game.gameId];
          }
        }
      }
    }

    if (stillLive) {
      scheduleNext(false);
    } else {
      console.log('sports: no live games — notifying C, awaiting next wakeup');
      sendPollResult(0, function(err) {
        if (!isPollingActive) return;
        if (err) {
          console.log('sports: SPORTS_POLL_RESULT failed — retrying on next tick');
          scheduleNext(true);
        } else {
          stopPolling();
        }
      });
    }
  });
}

function scheduleNext(isRetry) {
  if (!isPollingActive) return;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  if (isRetry) console.log('sports: retrying in ' + (POLL_INTERVAL_MS / 1000) + 's');
}

function startPolling() {
  if (isPollingActive) return;
  console.log('sports: starting poll loop');
  activeGameIds = {};
  pushedFinalIds = {};
  pushedScheduledIds = {};
  isPollingActive = true;
  tick();
}

function stopPolling() {
  if (!isPollingActive && !pollTimer) return;
  console.log('sports: stopping poll loop');
  isPollingActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function readKey(payload, name) {
  if (!payload) return undefined;
  if (payload[name] !== undefined) return payload[name];
  var idx = MESSAGE_KEYS_INDEX[name];
  if (idx !== undefined && payload[idx] !== undefined) return payload[idx];
  return undefined;
}

var MESSAGE_KEYS_INDEX = {
  SPORTS_APP_OPEN: 2,
  SPORTS_APP_EXIT: 3,
  SPORTS_POLL_RESULT: 4
};

function sendPollResult(count, onSent) {
  Pebble.sendAppMessage(
    { 'SPORTS_POLL_RESULT': count },
    function() {
      console.log('sports: SPORTS_POLL_RESULT=' + count + ' sent');
      if (onSent) onSent(null);
    },
    function(e) {
      var msg = (e && e.error && e.error.message) || 'unknown';
      console.log('sports: SPORTS_POLL_RESULT send failed: ' + msg);
      if (onSent) onSent(new Error(msg));
    }
  );
}

function registerWithServer() {
  var followed = getSavedFollowed();
  var accountToken;
  try {
    accountToken = Pebble.getAccountToken();
  } catch (e) {
    console.log('sports: getAccountToken error: ' + e);
  }
  if (!accountToken) {
    try { accountToken = Pebble.getWatchToken(); } catch (e2) {}
  }
  if (!accountToken) {
    console.log('sports: no account/watch token — cannot register');
    return;
  }

  Pebble.getTimelineToken(function(timelineToken) {
    var payload = JSON.stringify({
      accountToken: accountToken,
      timelineToken: timelineToken,
      followed: followed
    });
    var xhr = new XMLHttpRequest();
    xhr.open('POST', COMPANION_URL + '/api/sports/timeline/register', true);
    xhr.timeout = 10000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
      console.log('sports: registered with server status=' + xhr.status);
    };
    xhr.onerror = function() {
      console.log('sports: server registration failed (network error)');
    };
    xhr.ontimeout = function() {
      console.log('sports: server registration timed out');
    };
    xhr.send(payload);
  }, function(err) {
    console.log('sports: getTimelineToken failed: ' + err);
  });
}

Pebble.addEventListener('ready', function() {
  console.log('Sports Simplified pkjs ready');
  registerWithServer();
  startPolling();
});

Pebble.addEventListener('appmessage', function(e) {
  var payload = e && e.payload;
  if (readKey(payload, 'SPORTS_APP_OPEN') !== undefined) {
    console.log('sports: appmessage SPORTS_APP_OPEN — starting poll loop');
    startPolling();
  }
  if (readKey(payload, 'SPORTS_APP_EXIT') !== undefined) {
    console.log('sports: appmessage SPORTS_APP_EXIT — stopping poll loop');
    stopPolling();
  }
});

Pebble.addEventListener('showConfiguration', function() {
  var sport = getSavedSport() || 'nhl';
  var followed = getSavedFollowed();
  var base = COMPANION_URL + '/settings';
  var params = 'sport=' + encodeURIComponent(sport) +
               '&followed=' + encodeURIComponent(JSON.stringify(followed));
  Pebble.openURL(base + '?' + params);
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) return;
  var settings;
  try {
    settings = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    console.log('sports: webviewclosed parse error: ' + err.message);
    return;
  }
  var sport = settings && settings.SPORT;
  var teams = settings && settings.TEAMS;
  if (!sport || typeof sport !== 'string' || sport.length === 0) {
    console.log('sports: webviewclosed missing SPORT — ignoring payload');
    return;
  }
  if (!Array.isArray(teams)) {
    console.log('sports: webviewclosed missing TEAMS array — ignoring payload');
    return;
  }
  var followed = getSavedFollowed();
  followed[sport] = teams;
  try { localStorage.setItem(LS_FOLLOWED, JSON.stringify(followed)); } catch (e2) {}
  try { localStorage.setItem(LS_ACTIVE_SPORT, sport); } catch (e3) {}
  console.log('sports: saved active sport=' + sport +
              ' teams=' + teams.join(',') +
              ' followed=' + JSON.stringify(followed));
  registerWithServer();
});
