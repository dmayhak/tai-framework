import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { upwardCascadeTarget } from "./cascade-gate.js";

const dev = { issueType: SubtaskType.Dev };
const kickoff = { issueType: StoryType.Kickoff };
const story = { issueType: StoryType.Story };
const parent = (issueType: StoryType | SubtaskType | "epic", status: Status) => ({ issueType, status });

describe("upwardCascadeTarget (TAI-374/387, ADR page 47349832 rev 4)", () => {
    describe("work started (In Progress / In Review) -- the existing cascade", () => {
        for (const target of [Status.InProgress, Status.InReview]) {
            it(`${target}: moves a Backlog or To Do Story-level parent to In Progress`, () => {
                assert.equal(upwardCascadeTarget(dev, parent(StoryType.Story, Status.Backlog), target), Status.InProgress);
                assert.equal(upwardCascadeTarget(dev, parent(StoryType.Story, Status.ToDo), target), Status.InProgress);
            });
            it(`${target}: leaves a parent that is already started, Done or Canceled alone (never regress)`, () => {
                for (const s of [Status.InProgress, Status.InReview, Status.Done, Status.Canceled]) {
                    assert.equal(upwardCascadeTarget(dev, parent(StoryType.Story, s), target), null, s);
                }
            });
            it(`${target}: a normal Story still moves its Epic`, () => {
                assert.equal(upwardCascadeTarget(story, parent("epic", Status.Backlog), target), Status.InProgress);
                assert.equal(upwardCascadeTarget(story, parent("epic", Status.ToDo), target), Status.InProgress);
            });
            it(`${target}: Bug and Spike children still move their Epic`, () => {
                assert.equal(upwardCascadeTarget({ issueType: StoryType.Bug }, parent("epic", Status.Backlog), target), Status.InProgress);
                assert.equal(upwardCascadeTarget({ issueType: StoryType.Spike }, parent("epic", Status.Backlog), target), Status.InProgress);
            });
            it(`${target}: a KICKOFF Story never moves its Epic (refinement is not building)`, () => {
                assert.equal(upwardCascadeTarget(kickoff, parent("epic", Status.Backlog), target), null);
                assert.equal(upwardCascadeTarget(kickoff, parent("epic", Status.ToDo), target), null);
            });
            it(`${target}: a subtask of a Kickoff still moves the Kickoff itself`, () => {
                assert.equal(upwardCascadeTarget(dev, parent(StoryType.Kickoff, Status.Backlog), target), Status.InProgress);
            });
        }
    });

    describe("work scheduled (To Do) -- the new cascade", () => {
        it("moves a Backlog Story-level parent to To Do", () => {
            assert.equal(upwardCascadeTarget(dev, parent(StoryType.Story, Status.Backlog), Status.ToDo), Status.ToDo);
            assert.equal(upwardCascadeTarget(dev, parent(StoryType.Kickoff, Status.Backlog), Status.ToDo), Status.ToDo);
        });
        it("a normal Story moves a Backlog Epic to To Do, and so do Bug and Spike", () => {
            assert.equal(upwardCascadeTarget(story, parent("epic", Status.Backlog), Status.ToDo), Status.ToDo);
            assert.equal(upwardCascadeTarget({ issueType: StoryType.Bug }, parent("epic", Status.Backlog), Status.ToDo), Status.ToDo);
            assert.equal(upwardCascadeTarget({ issueType: StoryType.Spike }, parent("epic", Status.Backlog), Status.ToDo), Status.ToDo);
        });
        it("a KICKOFF Story never moves its Epic to To Do", () => {
            assert.equal(upwardCascadeTarget(kickoff, parent("epic", Status.Backlog), Status.ToDo), null);
        });
        it("only a Backlog parent moves: To Do, started, Done and Canceled parents are left alone", () => {
            for (const s of [Status.ToDo, Status.InProgress, Status.InReview, Status.Done, Status.Canceled]) {
                assert.equal(upwardCascadeTarget(dev, parent(StoryType.Story, s), Status.ToDo), null, s);
            }
        });
    });

    it("targets that are not 'scheduled' or 'started' never cascade upward", () => {
        for (const target of [Status.Backlog, Status.Done, Status.Canceled]) {
            assert.equal(upwardCascadeTarget(dev, parent(StoryType.Story, Status.Backlog), target), null, target);
        }
    });
});
