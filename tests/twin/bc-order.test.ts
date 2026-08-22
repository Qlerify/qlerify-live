import { describe, it, expect } from "vitest";
import { loadOntologyFromStrings } from "../../src/ontology/model.js";
import { entitiesForBc, defaultEntityForBc } from "../../src/ontology/bc-helpers.js";

const entity = { required: ["id"], fields: [{ name: "id", dataType: "string" }] };
const command = { required: ["id"], fields: [{ name: "id" }] };

const WORKFLOW = JSON.stringify({
  version: 1,
  boundedContext: "Qlerify",
  roles: ["System"],
  domainEvents: {
    UserSignedUp: {
      event: "User signed up",
      role: "System",
      command: { $ref: "#/schemas/commands/SignUp" },
      aggregateRoot: { $ref: "#/schemas/entities/User" },
      acceptanceCriteria: ["Given a visitor, When they sign up, Then a User exists"],
    },
  },
  schemas: { entities: { User: entity }, commands: { SignUp: command } },
  externalBoundedContexts: {
    Notifications: {
      domainEvents: {
        // Declared first on purpose: the `follows` chain must beat declaration order.
        HubspotSyncNotificationSent: {
          event: "Hubspot sync notification sent",
          role: "System",
          follows: [{ $ref: "#/externalBoundedContexts/Hubspot/domainEvents/HubspotContactCreated" }],
          command: { $ref: "#/schemas/commands/SendHubspotSyncNotification" },
          aggregateRoot: { $ref: "#/schemas/entities/HubspotSyncNotification" },
          acceptanceCriteria: ["Given a synced contact, When notified, Then a notification exists"],
        },
        SignupNotificationSent: {
          event: "Signup notification sent",
          role: "System",
          follows: [{ $ref: "#/domainEvents/UserSignedUp" }],
          command: { $ref: "#/schemas/commands/SendSignupNotification" },
          aggregateRoot: { $ref: "#/schemas/entities/SignupNotification" },
          acceptanceCriteria: ["Given a new user, When notified, Then a notification exists"],
        },
      },
      schemas: {
        entities: {
          HubspotSyncNotification: entity,
          SignupNotification: entity,
        },
        commands: { SendHubspotSyncNotification: command, SendSignupNotification: command },
      },
    },
    Hubspot: {
      domainEvents: {
        HubspotContactCreated: {
          event: "Hubspot contact created",
          role: "System",
          follows: [{ $ref: "#/externalBoundedContexts/Notifications/domainEvents/SignupNotificationSent" }],
          command: { $ref: "#/schemas/commands/CreateHubspotContact" },
          aggregateRoot: { $ref: "#/schemas/entities/HubspotContact" },
          acceptanceCriteria: ["Given a new user, When synced, Then a contact exists"],
        },
      },
      schemas: {
        entities: { HubspotContact: entity },
        commands: { CreateHubspotContact: command },
      },
    },
  },
});

const ont = loadOntologyFromStrings(WORKFLOW, null);

// Alphabetically this model reads Hubspot, Notifications, Qlerify — the reverse
// of the direction a user reads the diagram.
describe("workflow-ordered systems and tables", () => {
  it("orders bounded contexts by their earliest event", () => {
    expect(ont.boundedContexts).toEqual(["Qlerify", "Notifications", "Hubspot"]);
  });

  it("orders a context's tables by first use, not by declaration order", () => {
    expect(entitiesForBc(ont, "Notifications").map((e) => e.name)).toEqual([
      "SignupNotification",
      "HubspotSyncNotification",
    ]);
  });

  it("defaults a context to the table its earliest event touches", () => {
    expect(defaultEntityForBc(ont, "Notifications")).toBe("SignupNotification");
  });
});
