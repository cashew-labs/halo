import { Flex, MauiProvider, Text } from "maui";

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export default function Links() {
  return (
    <MauiProvider>
      <Flex column gap={4} p={8}>
        <Text role="status">{location.search || "home"}</Text>
        <a href="https://example.com/plain">Plain link</a>
        <a href="https://example.com/new-tab" target="_blank" rel="noreferrer">
          New tab link
        </a>
        <button
          type="button"
          onClick={() => window.open("https://example.com/window-open")}
        >
          Open window
        </button>
        <a href="./?page=settings">Settings</a>
      </Flex>
    </MauiProvider>
  );
}
