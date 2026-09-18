export type GoogleIntegrationDisplay = {
  name: string;
  description: string;
  icon: string;
};

const svglLibrary = "https://svgl.app/library";
const googleLogo = `${svglLibrary}/google.svg`;
const googleCloudLogo = `${svglLibrary}/google-cloud.svg`;

const googleIntegrationDisplays = {
  google_calendar: {
    name: "Google Calendar",
    description: "Search events and schedule meetings.",
    icon: `${svglLibrary}/google-calendar.svg`,
  },
  google_meet: {
    name: "Google Meet",
    description:
      "Start meetings and manage spaces, recordings, and transcripts.",
    icon: `${svglLibrary}/google-meet.svg`,
  },
  google_gmail: {
    name: "Gmail",
    description: "Search, read, draft, and manage email.",
    icon: `${svglLibrary}/gmail.svg`,
  },
  google_sheets: {
    name: "Google Sheets",
    description: "Read and update spreadsheets.",
    icon: `${svglLibrary}/google-sheets.svg`,
  },
  google_drive: {
    name: "Google Drive",
    description: "Search, read, create, and share files.",
    icon: `${svglLibrary}/drive.svg`,
  },
  google_docs: {
    name: "Google Docs",
    description: "Read and edit documents.",
    icon: googleLogo,
  },
  google_slides: {
    name: "Google Slides",
    description: "Read and update presentations.",
    icon: `${svglLibrary}/google-slides.svg`,
  },
  google_forms: {
    name: "Google Forms",
    description: "Create forms and read responses.",
    icon: googleLogo,
  },
  google_tasks: {
    name: "Google Tasks",
    description: "Manage task lists and due dates.",
    icon: googleLogo,
  },
  google_people: {
    name: "Google People",
    description: "Look up contacts and profile details.",
    icon: googleLogo,
  },
  google_photos_library: {
    name: "Google Photos Library",
    description: "Upload photos and manage albums.",
    icon: googleLogo,
  },
  google_photos_picker: {
    name: "Google Photos Picker",
    description: "Choose photos and videos from your library.",
    icon: googleLogo,
  },
  google_chat: {
    name: "Google Chat",
    description: "Read and send messages in Chat spaces.",
    icon: `${svglLibrary}/google-chat.svg`,
  },
  google_youtube_data: {
    name: "YouTube Data",
    description: "Manage channels, videos, and playlists.",
    icon: `${svglLibrary}/youtube.svg`,
  },
  google_search_console: {
    name: "Google Search Console",
    description: "See sites, sitemaps, and search performance.",
    icon: googleLogo,
  },
  google_classroom: {
    name: "Google Classroom",
    description: "Access courses, rosters, and coursework.",
    icon: `${svglLibrary}/google-classroom.svg`,
  },
  google_admin_directory: {
    name: "Google Admin Directory",
    description: "Manage users, groups, and org structure.",
    icon: googleLogo,
  },
  google_admin_reports: {
    name: "Google Admin Reports",
    description: "Read audit events and usage reports.",
    icon: googleLogo,
  },
  google_apps_script: {
    name: "Google Apps Script",
    description: "Manage script projects and deployments.",
    icon: googleLogo,
  },
  google_bigquery: {
    name: "Google BigQuery",
    description: "Explore datasets and tables and run SQL queries.",
    icon: googleCloudLogo,
  },
  google_cloud_resource_manager: {
    name: "Google Cloud Resource Manager",
    description: "See projects, folders, and organizations.",
    icon: googleCloudLogo,
  },
} as const satisfies Record<string, GoogleIntegrationDisplay>;

export function googleIntegrationDisplay(
  integration: string,
): GoogleIntegrationDisplay | undefined {
  // SAFETY: unknown slugs are missing catalog keys, so this index is undefined.
  return googleIntegrationDisplays[
    integration as keyof typeof googleIntegrationDisplays
  ];
}
