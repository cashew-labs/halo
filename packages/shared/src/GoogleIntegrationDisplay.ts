export type GoogleIntegrationDisplay = {
  name: string;
  description: string;
};

const googleIntegrationDisplays = {
  google_calendar: {
    name: "Google Calendar",
    description: "Create, find, and update events on your calendars.",
  },
  google_meet: {
    name: "Google Meet",
    description: "Start meetings and manage spaces, recordings, and transcripts.",
  },
  google_gmail: {
    name: "Gmail",
    description: "Read, send, and organize your email.",
  },
  google_sheets: {
    name: "Google Sheets",
    description: "Read and update spreadsheets.",
  },
  google_drive: {
    name: "Google Drive",
    description: "Find, organize, and share your files.",
  },
  google_docs: {
    name: "Google Docs",
    description: "Read and edit documents.",
  },
  google_slides: {
    name: "Google Slides",
    description: "Read and update presentations.",
  },
  google_forms: {
    name: "Google Forms",
    description: "Create forms and read responses.",
  },
  google_tasks: {
    name: "Google Tasks",
    description: "Manage task lists and due dates.",
  },
  google_people: {
    name: "Google People",
    description: "Look up contacts and profile details.",
  },
  google_photos_library: {
    name: "Google Photos Library",
    description: "Upload photos and manage albums.",
  },
  google_photos_picker: {
    name: "Google Photos Picker",
    description: "Choose photos and videos from your library.",
  },
  google_chat: {
    name: "Google Chat",
    description: "Read and send messages in Chat spaces.",
  },
  google_youtube_data: {
    name: "YouTube Data",
    description: "Manage channels, videos, and playlists.",
  },
  google_search_console: {
    name: "Google Search Console",
    description: "See sites, sitemaps, and search performance.",
  },
  google_classroom: {
    name: "Google Classroom",
    description: "Access courses, rosters, and coursework.",
  },
  google_admin_directory: {
    name: "Google Admin Directory",
    description: "Manage users, groups, and org structure.",
  },
  google_admin_reports: {
    name: "Google Admin Reports",
    description: "Read audit events and usage reports.",
  },
  google_apps_script: {
    name: "Google Apps Script",
    description: "Manage script projects and deployments.",
  },
  google_bigquery: {
    name: "Google BigQuery",
    description: "Query datasets and run jobs.",
  },
  google_cloud_resource_manager: {
    name: "Google Cloud Resource Manager",
    description: "See projects, folders, and organizations.",
  },
} as const satisfies Record<string, GoogleIntegrationDisplay>;

export type GoogleIntegrationSlug = keyof typeof googleIntegrationDisplays;

const displays = new Map<string, GoogleIntegrationDisplay>(
  Object.entries(googleIntegrationDisplays),
);

export function googleIntegrationDisplay(
  integration: string,
): GoogleIntegrationDisplay | undefined {
  return displays.get(integration);
}
