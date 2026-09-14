export type GoogleIntegrationDisplay = {
  name: string;
  description: string;
  icon: string;
};

const googleG =
  "https://fonts.gstatic.com/s/i/productlogos/googleg/v6/192px.svg";
const googlePhotosIcon =
  "https://www.gstatic.com/images/branding/product/2x/photos_96dp.png";

const googleIntegrationDisplays = {
  google_calendar: {
    name: "Google Calendar",
    description: "Search events and schedule meetings.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v8/192px.svg",
  },
  google_meet: {
    name: "Google Meet",
    description:
      "Start meetings and manage spaces, recordings, and transcripts.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/meet_2020q4/v8/192px.svg",
  },
  google_gmail: {
    name: "Gmail",
    description: "Search, read, draft, and manage email.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/web-96dp/logo_gmail_2020q4_color_2x_web_96dp.png",
  },
  google_sheets: {
    name: "Google Sheets",
    description: "Read and update spreadsheets.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/sheets_2020q4/v8/192px.svg",
  },
  google_drive: {
    name: "Google Drive",
    description: "Search, read, create, and share files.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/192px.svg",
  },
  google_docs: {
    name: "Google Docs",
    description: "Read and edit documents.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/docs_2020q4/v12/192px.svg",
  },
  google_slides: {
    name: "Google Slides",
    description: "Read and update presentations.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/slides_2020q4/v12/192px.svg",
  },
  google_forms: {
    name: "Google Forms",
    description: "Create forms and read responses.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/forms_2020q4/v6/192px.svg",
  },
  google_tasks: {
    name: "Google Tasks",
    description: "Manage task lists and due dates.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/tasks/v5/192px.svg",
  },
  google_people: {
    name: "Google People",
    description: "Look up contacts and profile details.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/contacts_2022/v2/192px.svg",
  },
  google_photos_library: {
    name: "Google Photos Library",
    description: "Upload photos and manage albums.",
    icon: googlePhotosIcon,
  },
  google_photos_picker: {
    name: "Google Photos Picker",
    description: "Choose photos and videos from your library.",
    icon: googlePhotosIcon,
  },
  google_chat: {
    name: "Google Chat",
    description: "Read and send messages in Chat spaces.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/chat_2020q4/v8/192px.svg",
  },
  google_youtube_data: {
    name: "YouTube Data",
    description: "Manage channels, videos, and playlists.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/youtube/v9/192px.svg",
  },
  google_search_console: {
    name: "Google Search Console",
    description: "See sites, sitemaps, and search performance.",
    icon: googleG,
  },
  google_classroom: {
    name: "Google Classroom",
    description: "Access courses, rosters, and coursework.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/classroom/v7/192px.svg",
  },
  google_admin_directory: {
    name: "Google Admin Directory",
    description: "Manage users, groups, and org structure.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/admin_2020q4/v6/192px.svg",
  },
  google_admin_reports: {
    name: "Google Admin Reports",
    description: "Read audit events and usage reports.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/admin_2020q4/v6/192px.svg",
  },
  google_apps_script: {
    name: "Google Apps Script",
    description: "Manage script projects and deployments.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/apps_script/v10/192px.svg",
  },
  google_bigquery: {
    name: "Google BigQuery",
    description: "Explore datasets and tables and run SQL queries.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/google_cloud/v6/192px.svg",
  },
  google_cloud_resource_manager: {
    name: "Google Cloud Resource Manager",
    description: "See projects, folders, and organizations.",
    icon: "https://fonts.gstatic.com/s/i/productlogos/google_cloud/v6/192px.svg",
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
