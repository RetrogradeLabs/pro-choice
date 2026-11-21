import { getDomainPageMetadata, renderDomainPage } from "@/lib/domain-page";

export async function generateMetadata() {
  return getDomainPageMetadata("coding");
}

export default async function CodingPage() {
  return renderDomainPage("coding");
}
