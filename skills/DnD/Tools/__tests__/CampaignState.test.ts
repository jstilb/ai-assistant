import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "fs";
import {
  createCampaign,
  loadCampaign,
  saveCampaign,
  listCampaigns,
  addSession,
  type Campaign,
  type CampaignSettings,
  type SessionData,
  CAMPAIGNS_DIR,
} from "../CampaignState";

const TEST_CAMPAIGNS_DIR = "/tmp/dnd-campaign-test";

describe("CampaignState", () => {
  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_CAMPAIGNS_DIR)) {
      rmSync(TEST_CAMPAIGNS_DIR, { recursive: true });
    }
    mkdirSync(TEST_CAMPAIGNS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_CAMPAIGNS_DIR)) {
      rmSync(TEST_CAMPAIGNS_DIR, { recursive: true });
    }
  });

  describe("createCampaign()", () => {
    test("creates a new campaign with generated ID", async () => {
      const settings: CampaignSettings = {
        name: "Dragon of Icespire Peak",
        setting: "Forgotten Realms",
        startingLevel: 1,
        maxPlayers: 5,
      };
      const campaign = await createCampaign(settings, TEST_CAMPAIGNS_DIR);
      expect(campaign.id).toBeDefined();
      expect(typeof campaign.id).toBe("string");
      expect(campaign.id.length).toBeGreaterThan(0);
      expect(campaign.name).toBe("Dragon of Icespire Peak");
      expect(campaign.setting).toBe("Forgotten Realms");
    });

    test("initializes empty collections", async () => {
      const campaign = await createCampaign(
        { name: "Test Campaign" },
        TEST_CAMPAIGNS_DIR
      );
      expect(campaign.partyMembers).toEqual([]);
      expect(campaign.npcs).toEqual([]);
      expect(campaign.locations).toEqual([]);
      expect(campaign.quests).toEqual([]);
      expect(campaign.sessionLogs).toEqual([]);
    });

    test("persists campaign to disk", async () => {
      const campaign = await createCampaign(
        { name: "Persistent Campaign" },
        TEST_CAMPAIGNS_DIR
      );
      const loaded = await loadCampaign(campaign.id, TEST_CAMPAIGNS_DIR);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe("Persistent Campaign");
    });

    test("records creation timestamp", async () => {
      const before = new Date().toISOString();
      const campaign = await createCampaign(
        { name: "Timestamped" },
        TEST_CAMPAIGNS_DIR
      );
      const after = new Date().toISOString();
      expect(campaign.createdAt).toBeDefined();
      expect(campaign.createdAt >= before).toBe(true);
      expect(campaign.createdAt <= after).toBe(true);
    });
  });

  describe("loadCampaign()", () => {
    test("loads an existing campaign by ID", async () => {
      const created = await createCampaign(
        { name: "Load Test" },
        TEST_CAMPAIGNS_DIR
      );
      const loaded = await loadCampaign(created.id, TEST_CAMPAIGNS_DIR);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.name).toBe("Load Test");
    });

    test("returns null for non-existent campaign", async () => {
      const loaded = await loadCampaign(
        "nonexistent-id",
        TEST_CAMPAIGNS_DIR
      );
      expect(loaded).toBeNull();
    });
  });

  describe("saveCampaign()", () => {
    test("updates existing campaign data", async () => {
      const campaign = await createCampaign(
        { name: "Save Test" },
        TEST_CAMPAIGNS_DIR
      );
      campaign.partyMembers.push({
        name: "Thorin",
        class: "Fighter",
        level: 5,
        race: "Dwarf",
        playerName: "John",
      });
      await saveCampaign(campaign, TEST_CAMPAIGNS_DIR);
      const loaded = await loadCampaign(campaign.id, TEST_CAMPAIGNS_DIR);
      expect(loaded!.partyMembers).toHaveLength(1);
      expect(loaded!.partyMembers[0].name).toBe("Thorin");
    });

    test("preserves all campaign fields after save", async () => {
      const campaign = await createCampaign(
        { name: "Full Save", setting: "Eberron", startingLevel: 3 },
        TEST_CAMPAIGNS_DIR
      );
      campaign.currentLocation = "Sharn";
      campaign.npcs.push({
        name: "Lady Elaydren",
        description: "A noblewoman of House Cannith",
        location: "Sharn",
        disposition: "friendly",
      });
      campaign.quests.push({
        name: "Retrieve the Schema",
        description: "Find the ancient schema in the Cogs",
        status: "active",
        givenBy: "Lady Elaydren",
      });
      await saveCampaign(campaign, TEST_CAMPAIGNS_DIR);
      const loaded = await loadCampaign(campaign.id, TEST_CAMPAIGNS_DIR);
      expect(loaded!.currentLocation).toBe("Sharn");
      expect(loaded!.npcs[0].name).toBe("Lady Elaydren");
      expect(loaded!.quests[0].status).toBe("active");
    });
  });

  describe("listCampaigns()", () => {
    test("returns empty array when no campaigns exist", async () => {
      const campaigns = await listCampaigns(TEST_CAMPAIGNS_DIR);
      expect(campaigns).toEqual([]);
    });

    test("lists all created campaigns", async () => {
      await createCampaign({ name: "Campaign 1" }, TEST_CAMPAIGNS_DIR);
      await createCampaign({ name: "Campaign 2" }, TEST_CAMPAIGNS_DIR);
      await createCampaign({ name: "Campaign 3" }, TEST_CAMPAIGNS_DIR);
      const campaigns = await listCampaigns(TEST_CAMPAIGNS_DIR);
      expect(campaigns).toHaveLength(3);
      const names = campaigns.map((c) => c.name);
      expect(names).toContain("Campaign 1");
      expect(names).toContain("Campaign 2");
      expect(names).toContain("Campaign 3");
    });

    test("returns summary objects with id and name", async () => {
      await createCampaign(
        { name: "Summary Test" },
        TEST_CAMPAIGNS_DIR
      );
      const campaigns = await listCampaigns(TEST_CAMPAIGNS_DIR);
      expect(campaigns[0]).toHaveProperty("id");
      expect(campaigns[0]).toHaveProperty("name");
      expect(campaigns[0]).toHaveProperty("createdAt");
    });
  });

  describe("addSession()", () => {
    test("adds a session log to campaign", async () => {
      const campaign = await createCampaign(
        { name: "Session Test" },
        TEST_CAMPAIGNS_DIR
      );
      const sessionData: SessionData = {
        number: 1,
        date: "2024-01-15",
        summary:
          "The party ventured into the goblin cave and defeated the bugbear chief.",
        notableEvents: [
          "Found the Cragmaw hideout",
          "Defeated Klarg the bugbear",
          "Rescued Sildar Hallwinter",
        ],
        lootFound: ["Jade statuette (40gp)", "Potion of Healing x2"],
        xpAwarded: 275,
      };
      const updated = await addSession(
        campaign.id,
        sessionData,
        TEST_CAMPAIGNS_DIR
      );
      expect(updated.sessionLogs).toHaveLength(1);
      expect(updated.sessionLogs[0].number).toBe(1);
      expect(updated.sessionLogs[0].summary).toContain("goblin cave");
    });

    test("appends multiple sessions in order", async () => {
      const campaign = await createCampaign(
        { name: "Multi Session" },
        TEST_CAMPAIGNS_DIR
      );
      await addSession(
        campaign.id,
        {
          number: 1,
          date: "2024-01-15",
          summary: "Session 1",
        },
        TEST_CAMPAIGNS_DIR
      );
      const updated = await addSession(
        campaign.id,
        {
          number: 2,
          date: "2024-01-22",
          summary: "Session 2",
        },
        TEST_CAMPAIGNS_DIR
      );
      expect(updated.sessionLogs).toHaveLength(2);
      expect(updated.sessionLogs[0].number).toBe(1);
      expect(updated.sessionLogs[1].number).toBe(2);
    });

    test("persists session data to disk", async () => {
      const campaign = await createCampaign(
        { name: "Persist Session" },
        TEST_CAMPAIGNS_DIR
      );
      await addSession(
        campaign.id,
        {
          number: 1,
          date: "2024-01-15",
          summary: "Persisted session",
        },
        TEST_CAMPAIGNS_DIR
      );
      const loaded = await loadCampaign(campaign.id, TEST_CAMPAIGNS_DIR);
      expect(loaded!.sessionLogs).toHaveLength(1);
      expect(loaded!.sessionLogs[0].summary).toBe("Persisted session");
    });

    test("throws for non-existent campaign", async () => {
      expect(
        addSession(
          "nonexistent",
          { number: 1, date: "2024-01-01", summary: "Test" },
          TEST_CAMPAIGNS_DIR
        )
      ).rejects.toThrow();
    });
  });
});
