**Data import**

Ingestion creates an immutable technical event log (create, update, or delete). Domain logic defined in the ontology interprets those events into business events and current-state projections. When the ontology or interpretation logic changes, projections can be replayed/recomputed from the raw event log, either lazily on read or through materialized rebuilds depending on scale.

When importing data that represents completed cases and updating the projections, recreate the likely events along the story line.

**Adapters**

The adapter code should be written by AI and tested on the fly and adapt the ontology to the source system by providing suggestions. So from an Event Storming board the AI can go back and forth, look at the source system api, look at the aggregates from the event storming board (likely inprecise) and stich it together and load the data.

**Authentication and authorisation**

Security is important to the data exhange with the source systems must comply with the higest security standards.

Can we use this idea for security? Unmodified paste from blog post:

*"The PII Problem (And Our Elegant Solution): Of course, event sourcing brings its own challenges. The big one: how do you handle PII in an immutable event log? What´s the PII Problem? we need to be very careful how we handle data ( as in every architecture ). And if a User requests data to be removed, we need to be able to do so. But how do you handle this with an immutable list of events like in Event Sourcing? We can´t just delete Events.. That breaks the whole point. But legally, you might have to delete personal data. Our solution: crypto shredding. We built a simple functionality that plugs into serialization of the Event Store - it encrypts PII-relevant data and stores the keys in Supabase Vault. When someone requests data deletion, we don't touch the events. We just destroy the encryption key. The data's still in the event log technically, but it's permanently unreadable."*

**Command**

The commands should be coded with AI on the fly based on the latest ontology and the lastest data model. Can we also create a function for detecting if an event has happened or not? And a readable description of the command and how it is detected?

**Event Store**

Probably we should have 2 events stores. One for the original data that can take a few different types:

- Upsert with unknown event: Creates a generic event for create and another generic events for update
- Delete
- Known event: Keeps the name of the event if we know it. 

The second event store is being rebuilt everytime the model or the data changes. It does its best to recreate the story line from the first storage based on all the data and the ontology.