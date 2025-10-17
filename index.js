/**
 * CalSnap · TeamSnap Custom Calendar
 * Single-user OAuth model with core functionality
 */

// The name of the KV namespace binding in wrangler.toml
const KV_NAMESPACE = 'CALSNAP_CALENDAR_STORE';

// Constants for the TeamSnap OAuth2 flow
const TEAMSNAP_OAUTH_URL = 'https://auth.teamsnap.com/oauth/authorize';
const TEAMSNAP_TOKEN_URL = 'https://auth.teamsnap.com/oauth/token';
const TEAMSNAP_API_URL = 'https://api.teamsnap.com/v3';

// =============================================================================
// CALENDAR GENERATION FUNCTIONS (PRESERVED FROM ORIGINAL)
// =============================================================================

/**
 * Serves the iCalendar feed for a given calendar token.
 */
async function serveCalendar(request, env, calendarId, forceText = false) {
  console.log('Serving calendar for ID:', calendarId);

  // Parse calendar token to get team info
  const tokenData = await parseCalendarToken(calendarId, env);
  if (!tokenData) {
    return new Response('Invalid or expired calendar token.', { status: 400 });
  }
  const { teamId, filterType } = tokenData;

  // Check for cache bypass parameter
  const url = new URL(request.url);
  const cacheOff = url.searchParams.get('cache') === 'off';
  const forceRefresh = url.searchParams.get('refresh') === 'true';

  if (cacheOff) {
    console.log('Cache bypass enabled - skipping cache check');
  }

  // Check for conditional request headers
  const ifModifiedSince = request.headers.get('If-Modified-Since');
  const ifNoneMatch = request.headers.get('If-None-Match');

  // Check for cached calendar data and last update timestamp (unless cache is off)
  const cacheKey = `calendar_${calendarId}`;
  const lastUpdateKey = `${cacheKey}_lastupdate`;
  const cachedIcs = (cacheOff || forceRefresh) ? null : await env[KV_NAMESPACE].get(cacheKey);
  const cachedLastUpdate = (cacheOff || forceRefresh) ? null : await env[KV_NAMESPACE].get(lastUpdateKey);

  // Clear cache if refresh is requested
  if (forceRefresh) {
    console.log('Force refresh enabled - clearing cache');
    await env[KV_NAMESPACE].delete(cacheKey);
    await env[KV_NAMESPACE].delete(lastUpdateKey);
  }

  // Handle conditional requests with cached data
  if (cachedIcs && cachedLastUpdate) {
    const lastModified = new Date(parseInt(cachedLastUpdate));
    const etag = `"${calendarId}-${cachedLastUpdate}"`;

    // Check If-Modified-Since header
    if (ifModifiedSince) {
      const ifModifiedSinceDate = new Date(ifModifiedSince);
      if (lastModified <= ifModifiedSinceDate) {
        return new Response(null, {
          status: 304,
          headers: {
            'Last-Modified': lastModified.toUTCString(),
            'ETag': etag,
            'Cache-Control': 'public, max-age=3600',
          }
        });
      }
    }

    // Check If-None-Match header (ETag)
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'Last-Modified': lastModified.toUTCString(),
          'ETag': etag,
          'Cache-Control': 'public, max-age=3600',
        }
      });
    }
  }

  let accessToken = await env[KV_NAMESPACE].get('oauth_access_token');

  // If the access token is expired, try to refresh it
  if (!accessToken) {
    const newTokens = await refreshAccessToken(env);
    if (newTokens) {
      accessToken = newTokens.access_token;
    } else {
      return new Response('Calendar access expired. Please re-authenticate.', { status: 401 });
    }
  }

  // Fetch team data to get the actual team name
  let actualTeamName = null;
  try {
    const teamData = await fetchTeamSnapData(`/teams/${teamId}`, env);
    if (teamData && teamData.collection && teamData.collection.items && teamData.collection.items.length > 0) {
      actualTeamName = teamData.collection.items[0].data.find(d => d.name === 'name').value;
    }
  } catch (error) {
    console.warn(`Could not fetch team name for team ${teamId}:`, error);
  }

  let eventsData;
  try {
    const apiUrl = `${TEAMSNAP_API_URL}/events/search?team_id=${teamId}`;

    const teamEventsResponse = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!teamEventsResponse.ok) {
      const errorText = await teamEventsResponse.text();
      console.error(`TeamSnap API error for team ${teamId}:`, teamEventsResponse.status, errorText);
      return new Response(`Error fetching team events: ${teamEventsResponse.status} ${errorText}`, { status: 500 });
    }

    eventsData = await teamEventsResponse.json();
  } catch (error) {
    console.error('Error fetching team events:', error);
    return new Response('Failed to fetch team events', { status: 500 });
  }

  if (!eventsData || !eventsData.collection || !eventsData.collection.items) {
    console.log('No events found for team:', teamId);
    eventsData = { collection: { items: [] } };
  }

  let events = eventsData.collection.items;

  // Filter out cancelled events
  events = events.filter(event => {
    const isCanceled = event.data?.find(d => d.name === 'is_canceled')?.value;
    return !isCanceled;
  });

  // Apply filter
  if (filterType === 'games') {
    events = events.filter(event => {
      const gameType = event.data?.find(d => d.name === 'game_type')?.value;
      const opponentName = event.data?.find(d => d.name === 'opponent_name')?.value;
      return gameType === 'Game' || opponentName;
    });
  }

  // Get the latest event update time for caching
  let latestEventUpdate = 0;
  events.forEach(event => {
    const updatedAt = event.data?.find(d => d.name === 'updated_at')?.value;
    if (updatedAt) {
      const updateTime = new Date(updatedAt).getTime();
      if (updateTime > latestEventUpdate) {
        latestEventUpdate = updateTime;
      }
    }
  });

  // If we have cached data and events haven't changed, return cached version
  if (cachedIcs && cachedLastUpdate && latestEventUpdate <= parseInt(cachedLastUpdate)) {
    const lastModified = new Date(parseInt(cachedLastUpdate));
    const etag = `"${calendarId}-${cachedLastUpdate}"`;

    return new Response(cachedIcs, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${teamId}_${filterType}.ics"`,
        'Last-Modified': lastModified.toUTCString(),
        'ETag': etag,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // Get custom team name for calendar title
  const customTeamName = await env[KV_NAMESPACE].get(`custom_team_name_${teamId}`);
  const calendarName = customTeamName || actualTeamName || '';

  // Generate calendar
  let icsContent = 'BEGIN:VCALENDAR\r\n';
  icsContent += 'VERSION:2.0\r\n';
  icsContent += 'PRODID:-//TeamSnap Custom Calendar//TeamSnap Events//EN\r\n';
  icsContent += 'CALSCALE:GREGORIAN\r\n';
  icsContent += 'METHOD:PUBLISH\r\n';

  // Add calendar name if available
  if (calendarName) {
    icsContent += `X-WR-CALNAME:${calendarName}\r\n`;
  }

  for (const event of events) {
    const eventData = {};
    event.data.forEach(d => {
      eventData[d.name] = d.value;
    });


    const startTime = eventData.start_date;
    const endTime = eventData.end_date;

    if (!startTime) continue;

    const startDate = new Date(startTime);
    const endDate = endTime ? new Date(endTime) : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

    const formatDate = (date) => {
      return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };

    const generateEventDescription = (event) => {
      let desc = '';

      // Title line - use proper Home/Away format for games
      if (event.is_game && event.opponent_name) {
        if (event.game_type === 'Home') {
          desc += `Home vs. ${event.opponent_name}\\n`;
        } else if (event.game_type === 'Away') {
          desc += `Away at ${event.opponent_name}\\n`;
        } else {
          // Fallback if game_type is unclear
          desc += `${event.label || 'TBD'} vs. ${event.opponent_name}\\n`;
        }
      }

      // Uniform (all events)
      if (event.uniform) desc += `Uniform: ${event.uniform}\\n`;

      // Location (all events)
      if (event.location_name) {
        desc += `\\n${event.location_name}`;
        if (event.additional_location_details && event.additional_location_details !== 'TBD') {
          desc += `\\n${event.additional_location_details}`;
        }
        desc += `\\n`;
      }

      // Arrival time (games only)
      if (event.is_game && event.arrival_date && event.minutes_to_arrive_early) {
        const timeOptions = {
          hour: 'numeric',
          minute: '2-digit'
        };
        if (event.time_zone_iana_name) {
          timeOptions.timeZone = event.time_zone_iana_name;
        }
        const arrivalTime = new Date(event.arrival_date).toLocaleTimeString('en-US', timeOptions);
        desc += `Arrival: ${arrivalTime} · ${event.minutes_to_arrive_early} min. early\\n`;
      }
      
      // Notes (all events)
      if (event.notes) desc += `\\n${event.notes}\\n`;

      return desc;
    };

    const generateEventFromTemplate = async (eventData, customTitle, formatDate) => {
      let description = generateEventDescription(eventData);
      description = description.replace(/\n/g, '\\n').replace(/,/g, '\\,');

      const updatedAt = eventData.updated_at ? new Date(eventData.updated_at) : new Date();
      let eventBlock = 'BEGIN:VEVENT\r\n';
      eventBlock += `UID:teamsnap-${eventData.id}@teamsnap.com\r\n`;
      eventBlock += `DTSTART:${formatDate(startDate)}\r\n`;
      eventBlock += `DTEND:${formatDate(endDate)}\r\n`;
      eventBlock += `SUMMARY:${customTitle.replace(/,/g, '\\,')}\r\n`;

      if (description) {
        eventBlock += `DESCRIPTION:${description}\r\n`;
      }

      // Enhanced LOCATION field with address
      if (eventData.location_name) {
        let locationText = eventData.location_name;

        // Fetch location address if location_id is available
        if (eventData.location_id) {
          try {
            const locationData = await fetchTeamSnapData(`/locations/${eventData.location_id}`, env);
            if (locationData?.collection?.items?.[0]) {
              const location = {};
              locationData.collection.items[0].data.forEach(field => {
                location[field.name] = field.value;
              });

              // Build address string
              let addressParts = [];
              if (location.address) addressParts.push(location.address);
              if (location.city) addressParts.push(location.city);
              if (location.state) addressParts.push(location.state);
              if (location.postal_code) addressParts.push(location.postal_code);

              if (addressParts.length > 0) {
                locationText += `\\n${addressParts.join(' ')}`;
              }
            }
          } catch (error) {
            console.warn(`Could not fetch location data for location ${eventData.location_id}:`, error);
          }
        }

        eventBlock += `LOCATION:${locationText.replace(/,/g, '\\,')}\r\n`;
      }

      // Set URL to TeamSnap event page
      const eventUrl = `https://go.teamsnap.com/${teamId}/schedule/view_event/${eventData.id}`;
      eventBlock += `URL:${eventUrl}\r\n`;

      eventBlock += `LAST-MODIFIED:${formatDate(updatedAt)}\r\n`;
      eventBlock += `DTSTAMP:${formatDate(new Date())}\r\n`;
      eventBlock += 'END:VEVENT\r\n';

      return eventBlock;
    };

    let customTitle;
    if (eventData.is_game) {
      // Games: Use existing custom format {custom name} vs {opponent}
      customTitle = await generateEventTitle(eventData, teamId, env, actualTeamName);
    } else {
      // Non-games: Use formatted_title, fallback to formatted_title_for_multi_team with team name replacement
      if (eventData.formatted_title) {
        // Add custom team name with colon before the event title
        const customTeamName = await env[KV_NAMESPACE].get(`custom_team_name_${teamId}`);
        const teamName = customTeamName || actualTeamName || 'Team';
        customTitle = `${teamName}: ${eventData.formatted_title}`;
      } else if (eventData.formatted_title_for_multi_team) {
        // Replace API team name with custom name
        customTitle = eventData.formatted_title_for_multi_team;
        // Get custom team name for replacement
        const customTeamName = await env[KV_NAMESPACE].get(`custom_team_name_${teamId}`);
        if (actualTeamName && customTeamName && customTitle.includes(actualTeamName)) {
          customTitle = customTitle.replace(actualTeamName, customTeamName);
        }
      } else {
        // Final fallback
        customTitle = eventData.label || eventData.name || 'Event';
      }
    }

    // Use template-based event generation
    icsContent += await generateEventFromTemplate(eventData, customTitle, formatDate);
  }

  icsContent += 'END:VCALENDAR\r\n';

  // Cache the generated calendar and update timestamp
  if (latestEventUpdate > 0) {
    await env[KV_NAMESPACE].put(cacheKey, icsContent, { expirationTtl: 3600 });
    await env[KV_NAMESPACE].put(lastUpdateKey, latestEventUpdate.toString(), { expirationTtl: 3600 });
  }

  const lastModified = new Date(latestEventUpdate || Date.now());
  const etag = `"${calendarId}-${latestEventUpdate || Date.now()}"`;

  // Check if user wants to view as text instead of download
  const formatAsText = forceText || url.searchParams.get('format') === 'text';

  const headers = {
    'Last-Modified': lastModified.toUTCString(),
    'ETag': etag,
    'Cache-Control': 'public, max-age=3600',
  };

  if (formatAsText) {
    // Display as plain text in browser - force inline display
    headers['Content-Type'] = 'text/plain; charset=utf-8';
    headers['Content-Disposition'] = 'inline';
    headers['X-Content-Type-Options'] = 'nosniff';
  } else {
    // Normal calendar download
    headers['Content-Type'] = 'text/calendar; charset=utf-8';
    headers['Content-Disposition'] = `attachment; filename="${teamId}_${filterType}.ics"`;
  }

  return new Response(icsContent, { headers });
}

/**
 * Generates calendar token for team/filter combination.
 */
async function generateCalendarToken(teamId, filterType, env, teamName) {
  const clientSecret = env.TEAMSNAP_CLIENT_SECRET || 'fallback-salt';
  const data = `${teamName}:${filterType}:${clientSecret}`;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 32);
}

/**
 * Parses a calendar token to extract team ID and filter type.
 */
async function parseCalendarToken(token, env) {
  const mapping = await env[KV_NAMESPACE].get(`calendar_token:${token}`);
  return mapping ? JSON.parse(mapping) : null;
}

/**
 * Helper function to generate custom event titles.
 * @param {Object} eventData - The event data from TeamSnap API
 * @param {string} teamId - The team ID
 * @param {Object} env - The Cloudflare Workers environment containing KV bindings
 * @param {string} actualTeamName - The actual team name from TeamSnap
 * @returns {Promise<string>} The formatted event title
 */
async function generateEventTitle(eventData, teamId, env, actualTeamName) {
  const customName = env ? await env[KV_NAMESPACE].get(`custom_team_name_${teamId}`) : null;
  const removeOpponentNames = env ? await env[KV_NAMESPACE].get(`remove_opponent_names_${teamId}`) : null;
  return generateEventTitleSync(eventData, customName, actualTeamName, removeOpponentNames === 'true');
}

/**
 * Synchronous helper function to generate custom event titles.
 * @param {Object} event - The event data
 * @param {string|null} customTeamName - Custom team name override
 * @param {string} actualTeamName - The actual team name from TeamSnap
 * @param {boolean} removeOpponentNames - Whether to hide opponent names from game titles
 * @returns {string} The formatted event title
 */
function generateEventTitleSync(event, customTeamName, actualTeamName, removeOpponentNames = false) {
  const teamName = customTeamName || actualTeamName || 'Team';

  const originalTitle = event.formatted_title_for_multi_team || event.formatted_title || event.name || 'Untitled Event';

  const isGame = event.game_type === 'Game' || event.opponent_name;

  if (isGame && event.opponent_name) {
    // If removeOpponentNames is enabled, use simple "Team: Game" format
    if (removeOpponentNames) {
      return `${teamName}: Game`;
    }
    return `${teamName} vs. ${event.opponent_name}`;
  } else if (isGame) {
    // For games without opponent data, keep original title format regardless of removeOpponentNames setting
    let title = originalTitle;
    if (actualTeamName && customTeamName) {
      title = title.replace(new RegExp(actualTeamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), customTeamName);
    }
    return title;
  } else {
    let title = originalTitle;
    if (actualTeamName && customTeamName) {
      title = title.replace(new RegExp(actualTeamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), customTeamName);
    }
    return title;
  }
}

/**
 * Helper function to fetch data from TeamSnap API, handling token refresh.
 */
async function fetchTeamSnapData(endpoint, env) {
  let accessToken = await env[KV_NAMESPACE].get('oauth_access_token');

  if (!accessToken) {
    const newTokens = await refreshAccessToken(env);
    if (newTokens) {
      accessToken = newTokens.access_token;
    } else {
      return null;
    }
  }

  const response = await fetch(`${TEAMSNAP_API_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  });

  if (response.status === 401) {
    console.log('Token expired, attempting refresh...');
    const newTokens = await refreshAccessToken(env);
    if (newTokens) {
      const retryResponse = await fetch(`${TEAMSNAP_API_URL}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${newTokens.access_token}`,
          'Accept': 'application/json',
        },
      });
      return retryResponse.ok ? await retryResponse.json() : null;
    }
    return null;
  }

  return response.ok ? await response.json() : null;
}

/**
 * Refreshes the access token using the refresh token.
 */
async function refreshAccessToken(env) {
  const refreshToken = await env[KV_NAMESPACE].get('oauth_refresh_token');
  if (!refreshToken) {
    console.log('No refresh token available');
    return null;
  }

  try {
    const response = await fetch(TEAMSNAP_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.TEAMSNAP_CLIENT_ID,
        client_secret: env.TEAMSNAP_CLIENT_SECRET,
      }),
    });

    if (response.ok) {
      const tokenData = await response.json();

      // Store new tokens
      await env[KV_NAMESPACE].put('oauth_access_token', tokenData.access_token, {
        expirationTtl: tokenData.expires_in
      });

      if (tokenData.refresh_token) {
        await env[KV_NAMESPACE].put('oauth_refresh_token', tokenData.refresh_token);
      }

      // Store expiry time
      const expiresAt = Date.now() + (tokenData.expires_in * 1000);
      await env[KV_NAMESPACE].put('oauth_expires_at', expiresAt.toString());

      console.log('Token refreshed successfully');
      return tokenData;
    } else {
      console.error('Token refresh failed:', response.status);
      return null;
    }
  } catch (error) {
    console.error('Error refreshing token:', error);
    return null;
  }
}

// =============================================================================
// SIMPLE OAUTH IMPLEMENTATION
// =============================================================================

/**
 * Check if user is authenticated.
 */
async function isAuthenticated(env) {
  const accessToken = await env[KV_NAMESPACE].get('oauth_access_token');
  const expiresAt = await env[KV_NAMESPACE].get('oauth_expires_at');

  if (!accessToken) {
    return false;
  }

  // Check if token is expired
  if (expiresAt && Date.now() > parseInt(expiresAt)) {
    // Try to refresh
    const newTokens = await refreshAccessToken(env);
    return !!newTokens;
  }

  return true;
}

/**
 * Start OAuth authorization flow.
 */
function startOAuth(request, env) {
  const { TEAMSNAP_CLIENT_ID } = env;
  const workerUrl = new URL(request.url).origin;

  const params = new URLSearchParams({
    client_id: TEAMSNAP_CLIENT_ID,
    redirect_uri: `${workerUrl}/auth-callback`,
    response_type: 'code',
  });

  const authorizationUrl = `${TEAMSNAP_OAUTH_URL}?${params.toString()}`;
  return Response.redirect(authorizationUrl, 302);
}

/**
 * Handle OAuth callback.
 */
async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return new Response('Missing authorization code', { status: 400 });
  }

  try {
    const workerUrl = url.origin;

    const response = await fetch(TEAMSNAP_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${workerUrl}/auth-callback`,
        client_id: env.TEAMSNAP_CLIENT_ID,
        client_secret: env.TEAMSNAP_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Token exchange failed:', response.status, errorText);
      return new Response('Authentication failed', { status: 500 });
    }

    const tokenData = await response.json();

    // Store tokens
    await env[KV_NAMESPACE].put('oauth_access_token', tokenData.access_token, {
      expirationTtl: tokenData.expires_in
    });

    if (tokenData.refresh_token) {
      await env[KV_NAMESPACE].put('oauth_refresh_token', tokenData.refresh_token);
    }

    // Store expiry time
    const expiresAt = Date.now() + (tokenData.expires_in * 1000);
    await env[KV_NAMESPACE].put('oauth_expires_at', expiresAt.toString());

    // Get user info
    const userResponse = await fetch(`${TEAMSNAP_API_URL}/me`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json',
      },
    });

    if (userResponse.ok) {
      const userData = await userResponse.json();
      await env[KV_NAMESPACE].put('oauth_user_info', JSON.stringify(userData));
    }

    console.log('OAuth successful, redirecting to settings');
    return Response.redirect(`${workerUrl}/settings`, 302);

  } catch (error) {
    console.error('OAuth callback error:', error);
    return new Response('Authentication failed', { status: 500 });
  }
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

/**
 * Handle API requests.
 */
async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Check authentication for API requests
  if (!(await isAuthenticated(env))) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/api/teams') {
    return handleTeamsApi(request, env);
  }

  if (path === '/api/team-settings') {
    return handleTeamSettingsApi(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * Handle teams API endpoint.
 */
async function handleTeamsApi(request, env) {
  try {
    const userData = await fetchTeamSnapData('/me', env);

    if (!userData || !userData.collection || !userData.collection.items || !userData.collection.items[0]) {
      return new Response(JSON.stringify({ error: 'User data not found' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const user = userData.collection.items[0];
    const userEmail = user.data.find(d => d.name === 'email')?.value;
    const userId = user.data.find(d => d.name === 'id')?.value;

    // Validate user email against allowed email
    if (!env.ALLOWED_USER_EMAIL) {
      return new Response('Access denied: ALLOWED_USER_EMAIL environment variable is required', { status: 403 });
    }
    if (userEmail !== env.ALLOWED_USER_EMAIL) {
      return new Response(`Access denied: The email '${userEmail}' is not authorized to use this service.`, { status: 403 });
    }

    // Get teams
    const teamsResponse = await fetchTeamSnapData(`/teams/active?user_id=${userId}`, env);

    if (!teamsResponse || !teamsResponse.collection) {
      return new Response(JSON.stringify({ error: 'Teams data not found' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const teams = teamsResponse.collection.items || [];
    const url = new URL(request.url);
    const workerUrl = url.origin;

    const teamsWithCalendars = await Promise.all(teams.map(async (team) => {
      const teamData = {};
      team.data.forEach(d => {
        teamData[d.name] = d.value;
      });

      // Get custom team name and opponent name removal setting
      const customName = await env[KV_NAMESPACE].get(`custom_team_name_${teamData.id}`);
      const removeOpponentNames = await env[KV_NAMESPACE].get(`remove_opponent_names_${teamData.id}`);

      // Generate calendar tokens
      const allEventsToken = await generateCalendarToken(teamData.id, 'all', env, teamData.name);
      const gamesOnlyToken = await generateCalendarToken(teamData.id, 'games', env, teamData.name);

      // Store token mappings
      await env[KV_NAMESPACE].put(`calendar_token:${allEventsToken}`, JSON.stringify({
        teamId: teamData.id,
        filterType: 'all'
      }), { expirationTtl: 31536000 });

      await env[KV_NAMESPACE].put(`calendar_token:${gamesOnlyToken}`, JSON.stringify({
        teamId: teamData.id,
        filterType: 'games'
      }), { expirationTtl: 31536000 });

      return {
        id: teamData.id,
        name: teamData.name,
        customName: customName,
        removeOpponentNames: removeOpponentNames === 'true',
        calendars: {
          all: `${workerUrl}/${allEventsToken}.ics`,
          games: `${workerUrl}/${gamesOnlyToken}.ics`
        }
      };
    }));

    return new Response(JSON.stringify({
      user: { email: userEmail },
      teams: teamsWithCalendars
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Teams API error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch teams' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Handle team settings API endpoint.
 */
async function handleTeamSettingsApi(request, env) {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const teamId = url.searchParams.get('teamId');

    if (!teamId) {
      return new Response(JSON.stringify({ error: 'Missing teamId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const customName = await env[KV_NAMESPACE].get(`custom_team_name_${teamId}`);
    const removeOpponentNames = await env[KV_NAMESPACE].get(`remove_opponent_names_${teamId}`);

    return new Response(JSON.stringify({
      customName,
      removeOpponentNames: removeOpponentNames === 'true'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'POST') {
    const { teamId, customName, removeOpponentNames } = await request.json();

    if (!teamId) {
      return new Response(JSON.stringify({ error: 'Missing teamId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (customName) {
      await env[KV_NAMESPACE].put(`custom_team_name_${teamId}`, customName);
    } else {
      await env[KV_NAMESPACE].delete(`custom_team_name_${teamId}`);
    }

    // Handle removeOpponentNames setting
    if (removeOpponentNames !== undefined) {
      if (removeOpponentNames) {
        await env[KV_NAMESPACE].put(`remove_opponent_names_${teamId}`, 'true');
      } else {
        await env[KV_NAMESPACE].delete(`remove_opponent_names_${teamId}`);
      }
    }

    // Invalidate cached calendars when settings change
    // We need to get the team name to regenerate tokens
    const teamData = await fetchTeamSnapData(`/teams/${teamId}`, env);
    let teamName = null;
    if (teamData && teamData.collection && teamData.collection.items && teamData.collection.items.length > 0) {
      teamName = teamData.collection.items[0].data.find(d => d.name === 'name').value;
    }

    if (teamName) {
      const allEventsToken = await generateCalendarToken(teamId, 'all', env, teamName);
      const gamesOnlyToken = await generateCalendarToken(teamId, 'games', env, teamName);

      await env[KV_NAMESPACE].delete(`calendar_${allEventsToken}`);
      await env[KV_NAMESPACE].delete(`calendar_${allEventsToken}_lastupdate`);
      await env[KV_NAMESPACE].delete(`calendar_${gamesOnlyToken}`);
      await env[KV_NAMESPACE].delete(`calendar_${gamesOnlyToken}_lastupdate`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
}

// =============================================================================
// MAIN REQUEST HANDLER
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle API requests
    if (path.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    // Handle iCalendar requests (public, no auth required)
    if (path.endsWith('.ics')) {
      const calendarId = path.substring(1, path.length - 4);
      return serveCalendar(request, env, calendarId);
    }

    // Handle text viewing of calendar (public, no auth required)
    if (path.endsWith('.txt')) {
      const calendarId = path.substring(1, path.length - 4);
      return serveCalendar(request, env, calendarId, true); // true = format as text
    }

    // Handle OAuth callback
    if (path === '/auth-callback') {
      return handleOAuthCallback(request, env);
    }

    // Handle root page - smart routing
    if (path === '/') {
      const authenticated = await isAuthenticated(env);
      if (authenticated) {
        return Response.redirect(`${url.origin}/settings`, 302);
      } else {
        return startOAuth(request, env);
      }
    }

    // Handle settings page
    if (path === '/settings') {
      const authenticated = await isAuthenticated(env);
      if (!authenticated) {
        return startOAuth(request, env);
      }

      // Serve basic settings page
      return new Response(getSettingsHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // Default: serve landing page or redirect to auth
    const authenticated = await isAuthenticated(env);
    if (authenticated) {
      return Response.redirect(`${url.origin}/settings`, 302);
    } else {
      return startOAuth(request, env);
    }
  }
};

// =============================================================================
// BASIC HTML SETTINGS PAGE (NO STYLING)
// =============================================================================

function getSettingsHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TeamSnap Calendar Settings</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@0.9.4/css/bulma.min.css">
    <style>
        .calendar-url { font-family: monospace; font-size: 0.875em; background-color: #f8f9fa; }
    </style>
</head>
<body>
    <section class="hero is-info">
        <div class="hero-body">
            <div class="container">
                <h1 class="title has-text-white">TeamSnap Calendar Settings</h1>
                <p class="subtitle has-text-white">Manage your custom calendar feeds</p>
            </div>
        </div>
    </section>

    <div class="container">
        <section class="section">
            <div id="loading" class="box has-text-centered">
                <span>Loading...</span>
            </div>

            <div id="content" style="display: none;">
                <div class="box">
                    <p class="has-text-weight-semibold">Logged in as: <span id="user-email" class="has-text-primary"></span></p>
                </div>

                <div class="box">
                    <h2 class="title is-4">Your Teams</h2>
                    <div id="teams-list"></div>
                </div>
            </div>
        </section>
    </div>

    <script>
        async function loadData() {
            try {
                const response = await fetch('/api/teams');
                const data = await response.json();

                if (data.error) {
                    document.getElementById('loading').textContent = 'Error: ' + data.error;
                    return;
                }

                document.getElementById('user-email').textContent = data.user.email;

                const teamsList = document.getElementById('teams-list');
                teamsList.innerHTML = '';

                data.teams.forEach(team => {
                    const teamDiv = document.createElement('div');
                    teamDiv.className = 'box';
                    teamDiv.innerHTML = \`
                        <h3 class="title is-5">\${team.name}</h3>

                        <div class="field">
                            <label class="label">Custom Team Name</label>
                            <div class="field has-addons">
                                <div class="control is-expanded">
                                    <input class="input" type="text" id="custom-name-\${team.id}" value="\${team.customName || ''}" placeholder="Enter custom name (optional)">
                                </div>
                                <div class="control">
                                    <button class="button is-primary" onclick="saveTeamSettings('\${team.id}')">Save</button>
                                </div>
                            </div>
                        </div>

                        <div class="field">
                            <label class="checkbox">
                                <input type="checkbox" id="remove-opponent-\${team.id}" \${team.removeOpponentNames ? 'checked' : ''}>
                                Show only team name in game titles
                            </label>
                            <p class="help">When enabled, game titles show "\${team.customName || team.name}: Game" instead of "\${team.customName || team.name} vs. Opponent Name"</p>
                        </div>

                        <div class="field">
                            <label class="label">All Events Calendar</label>
                            <div class="control">
                                <input class="input calendar-url" type="text" value="\${team.calendars.all}" readonly onclick="this.select()">
                            </div>
                            <p class="help">
                                <a href="\${team.calendars.all.replace('https://', 'webcal://')}">Subscribe to All Events</a> |
                                <a href="#" onclick="copyToClipboard('\${team.calendars.all}', this); return false;">Copy All Events URL</a>
                            </p>
                        </div>

                        <div class="field">
                            <label class="label">Games Only Calendar</label>
                            <div class="control">
                                <input class="input calendar-url" type="text" value="\${team.calendars.games}" readonly onclick="this.select()">
                            </div>
                            <p class="help">
                                <a href="\${team.calendars.games.replace('https://', 'webcal://')}">Subscribe to Games Only</a> |
                                <a href="#" onclick="copyToClipboard('\${team.calendars.games}', this); return false;">Copy Games Only URL</a>
                            </p>
                        </div>
                    \`;
                    teamsList.appendChild(teamDiv);
                });

                document.getElementById('loading').style.display = 'none';
                document.getElementById('content').style.display = 'block';

            } catch (error) {
                document.getElementById('loading').textContent = 'Error loading data: ' + error.message;
            }
        }

        async function copyToClipboard(text, link) {
            try {
                await navigator.clipboard.writeText(text);

                // Show success state
                const originalText = link.textContent;
                link.textContent = 'Copied!';

                // Reset after 2 seconds
                setTimeout(() => {
                    link.textContent = originalText;
                }, 2000);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);

                // Show success state
                const originalText = link.textContent;
                link.textContent = 'Copied!';

                // Reset after 2 seconds
                setTimeout(() => {
                    link.textContent = originalText;
                }, 2000);
            }
        }

        async function saveTeamSettings(teamId) {
            const nameInput = document.getElementById(\`custom-name-\${teamId}\`);
            const removeOpponentCheckbox = document.getElementById(\`remove-opponent-\${teamId}\`);
            const button = nameInput.parentElement.nextElementSibling.querySelector('button');
            const customName = nameInput.value.trim();
            const removeOpponentNames = removeOpponentCheckbox.checked;

            // Show loading state
            button.textContent = 'Saving...';
            button.disabled = true;

            try {
                const response = await fetch('/api/team-settings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        teamId: teamId,
                        customName: customName || null,
                        removeOpponentNames: removeOpponentNames
                    })
                });

                const result = await response.json();

                if (result.success) {
                    // Show success state
                    button.textContent = 'Saved!';
                    button.className = 'button is-success';

                    // Reset after 2 seconds and reload
                    setTimeout(() => {
                        location.reload();
                    }, 1500);
                } else {
                    throw new Error('Save failed');
                }
            } catch (error) {
                // Show error state
                button.textContent = 'Error';
                button.className = 'button is-danger';

                // Reset after 2 seconds
                setTimeout(() => {
                    button.textContent = 'Save';
                    button.className = 'button is-primary';
                    button.disabled = false;
                }, 2000);
            }
        }

        // Load data when page loads
        loadData();
    </script>
</body>
</html>`;
}