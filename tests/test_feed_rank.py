import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from tools import feed_rank

PROFILE = {
    "years_experience": 5,
    "skills": {"languages": ["python", "java", "sql"], "cloud": ["aws", "terraform", "kubernetes"]},
}
TODAY = date(2026, 10, 25)


def job(**kw):
    base = {"id": "x", "title": "Senior Software Engineer", "company": "Acme", "location": "Toronto, ON",
            "date": "2026-10-24", "url": "https://example.com/1", "region": "canada",
            "description": "Python, AWS, Terraform and Kubernetes. 5+ years of experience."}
    base.update(kw)
    return base


class FeedRankTest(unittest.TestCase):
    def rank(self, *jobs):
        with tempfile.TemporaryDirectory() as d:
            feed = Path(d, "feed.json")
            feed.write_text(json.dumps({"meta": {}, "results": list(jobs)}), encoding="utf-8")
            prof = Path(d, "profile.json")
            prof.write_text(json.dumps(PROFILE), encoding="utf-8")
            out = Path(d, "out.json")
            feed_rank.main(["--feed", str(feed), "--profile", str(prof), "--out", str(out), "--today", TODAY.isoformat()])
            return json.loads(out.read_text(encoding="utf-8"))["jobs"]

    def test_strong_overlap_ranks_first(self):
        jobs = self.rank(job(url="u1"), job(url="u2", title="Senior Engineer", description="Rust and Go, Kafka, Scala."))
        self.assertEqual(jobs[0]["url"], "u1")
        self.assertEqual(jobs[0]["score"]["verdict"], "strong")
        self.assertIn("terraform", jobs[0]["score"]["matched"])

    def test_large_experience_gap_blocks(self):
        [j] = self.rank(job(description="Python, AWS, Terraform, Kubernetes. 10+ years of experience required."))
        self.assertEqual(j["score"]["verdict"], "blocked")
        self.assertIn("asks for 10+ years, you have 5", j["score"]["reasons"])

    def test_range_uses_its_low_end(self):
        self.assertEqual(feed_rank.required_years("5-8 years of experience"), 5)
        self.assertEqual(feed_rank.required_years("3+ years Python, 7+ years total"), 7)

    def test_clearance_blocks(self):
        [j] = self.rank(job(description="Python AWS Terraform Kubernetes. Active security clearance required."))
        self.assertEqual(j["score"]["verdict"], "blocked")

    def test_us_remote_authorization_is_flagged_not_blocked(self):
        [j] = self.rank(job(region="us-remote", location="Remote - US",
                            description="Python AWS Terraform Kubernetes. Must be authorized to work in the United States."))
        self.assertNotEqual(j["score"]["verdict"], "blocked")
        self.assertEqual(j["score"]["flags"], ["needs US work authorization / residency"])

    def test_off_track_and_stale_postings_drop(self):
        jobs = {j["url"]: j["score"]["pct"] for j in self.rank(job(url="a"), job(url="b", date="2026-01-01"),
                                                               job(url="c", title="Senior Mobile Engineer"))}
        self.assertGreater(jobs["a"], jobs["b"])
        self.assertGreater(jobs["a"], jobs["c"])

    def test_duplicate_urls_collapse(self):
        self.assertEqual(len(self.rank(job(), job())), 1)


if __name__ == "__main__":
    unittest.main()
