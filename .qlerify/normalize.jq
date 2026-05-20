def bc_for_entity:
  if . == "Demand" or . == "BuildPlan" or . == "Build" or . == "BuildDemand" then "Helix"
  elif . == "Project" or . == "BomItem" or . == "EngineeringRelease" then "PRIM"
  elif . == "PurchaseOrder" or . == "WorkOrder" then "SAP"
  elif . == "EngineeringChange" then "ESTER"
  elif . == "ProductionSite" or . == "ProductionLine" or . == "LineBooking" then "Compass"
  elif . == "TestResult" then "Test"
  elif . == "Unit" or . == "Shipment" then "Logistics"
  else "Unassigned"
  end;

.schemas.entities |= with_entries(
  .value.boundedContext = (.key | bc_for_entity)
  | .value.fields |= map(
      if (.relatedEntity != null) then
        .relatedEntity["$ref"] |= gsub("#/externalBoundedContexts/[^/]+/"; "#/")
      else . end
    )
)
